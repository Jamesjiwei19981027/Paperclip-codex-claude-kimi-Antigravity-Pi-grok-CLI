import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { EventEmitter } from 'node:events';
import { ConfigError, loadConfig } from './config.ts';
import { assertTransportAllowed } from './transport-check.ts';
import { acquireLock } from './lock.ts';
import { Logger } from './logger.ts';
import { connectLoop } from './connection.ts';
import { JobRunner } from './job-runner.ts';
import { createInstallControl } from './install-control.ts';
import { AGENT_VERSION } from './executors/echo.ts';
import { resolveCodexProxy } from './executors/codex-proxy.ts';
import type { JobStart } from './protocol.ts';
import { CODE_MODE_HOST_RECOVERY, hasCodexLogin, inspectCodexInstallation, isCodexExecutableReady, missingRuntimeFiles, readCodexVersion, runCodexLogin } from './codex-cli.ts';

export function installInterrupts(signals:Pick<EventEmitter,'on'|'off'>,runner:{shutdown:()=>Promise<void>;force:()=>void|Promise<void>},close:()=>void|Promise<void>,exit:(code:number)=>void){
 let count=0;
 const handle=()=>{if(++count>1){try{const forced=runner.force();if(forced&&typeof (forced as Promise<void>).then==='function')void Promise.resolve(forced).then(()=>exit(0),()=>exit(0));else exit(0);}catch{exit(0);}return;}void runner.shutdown().catch(()=>{}).then(close).catch(()=>{});};
 signals.on('SIGINT',handle);
 return ()=>{signals.off('SIGINT',handle);};
}
const usage='用法：node member-agent/src/main.ts run|check|login [--config <文件>]，或 version';
async function checkCodex(config:Awaited<ReturnType<typeof loadConfig>>,print:(line:string)=>void):Promise<{ok:boolean;version:string|null}>{
 const proxy=await resolveCodexProxy({env:process.env,serverUrl:config.serverUrl,warn:message=>print(`警告：${message}`)});
 print(`Codex 代理：${proxy.message}`);
 const result=await inspectCodexInstallation({executable:config.codexExecutable??'',codexHome:config.codexHome??'',runtimeDir:config.runtimeDir??''});
 print(`${result.executable?'通过':'失败'}：Codex 可执行文件${result.executable?'存在':'不存在或不是 .exe'}`);
 print(`${result.codeModeHost?'通过':'失败'}：Codex 工具宿主 ${result.codeModeHost?'codex-code-mode-host.exe 存在':CODE_MODE_HOST_RECOVERY}`);
 print(`${result.version?'通过':'失败'}：${result.version?`Codex 版本 ${result.version}`:'无法读取 Codex 版本'}`);
 print(`${result.loggedIn?'通过':'失败'}：Codex 登录凭据${result.loggedIn?'已存在':'不存在，请先运行 login'}`);
 print(`${result.missingRuntime.length===0?'通过':'失败'}：运行时包${result.missingRuntime.length===0?'完整':`缺少 ${result.missingRuntime.join(', ')}`}；如需重建，请运行 build-runtime`);
 return {ok:result.executable&&result.codeModeHost&&!!result.version&&result.loggedIn&&result.missingRuntime.length===0,version:result.version};
}
export async function main(args=process.argv.slice(2)):Promise<number>{
 const command=args[0];let configPath:string|undefined;
 if(!['run','check','login','version'].includes(command)|| (command==='version'&&args.length!==1)){console.error(usage);return 2;}
 for(let i=1;i<args.length;i++){if(args[i]!=='--config'||!args[i+1]||configPath!==undefined){console.error(usage);return 2;}configPath=args[++i];}
 if(command==='version'){console.log(AGENT_VERSION);return 0;}
 const stateDir=join(process.env.APPDATA??join(homedir(),'AppData','Roaming'),'paperclip-member-agent');
 const warnings:string[]=[];
 let release:(()=>Promise<void>)|undefined;
 let logger:Logger|undefined;
 try{
  const config=await loadConfig(configPath,process.env,message=>warnings.push(message),{requireAgentKey:command!=='login'});
  if(command==='login'){
   if(config.executor==='codebuddy'){
    const {readCodeBuddyVersion,runCodeBuddyLogin,hasCodeBuddyLogin,verifyCodeBuddyPackage,CODEBUDDY_VERSION}=await import('./codebuddy-cli.ts');
    if((await verifyCodeBuddyPackage(config.codebuddyEntry!)).length)throw new ConfigError(['配置错误：CodeBuddy 安装包清单未通过，请重新获取完整安装包。']);
    if(await readCodeBuddyVersion(config.codebuddyEntry!,config.codebuddyHome!)!==CODEBUDDY_VERSION)throw new ConfigError(['配置错误：CodeBuddy 必须为固定版本 2.169.0。']);
    await mkdir(config.codebuddyHome!,{recursive:true});
    console.log('请在 CodeBuddy 界面输入 /login 完成登录后退出。将共用成员本机 CodeBuddy 登录，仅会话、设置和模型配置使用成员代理专属目录。');
    const code=await runCodeBuddyLogin(config.codebuddyEntry!,config.codebuddyHome!);
    const exists=await hasCodeBuddyLogin();
    console.log(exists?'CodeBuddy 登录凭据已存在（仅检查存在性，未读取内容）。':'未发现 CodeBuddy 登录凭据，请运行 start.ps1 -Mode login 后重试。');
    return code|| (exists?0:1);
   }
   if(config.executor!=='codex')throw new ConfigError(['配置错误：login 只适用于 executor="codex"，请先配置 Codex 执行器。']);
   if(!config.codexExecutable||!config.codexHome)throw new ConfigError(['配置错误：login 需要设置 codexExecutable 与 codexHome，请使用独立的成员代理 Codex 目录。']);
   if(!await isCodexExecutableReady(config.codexExecutable))throw new ConfigError(['配置错误：codexExecutable 不存在或不可执行，请填写固定版本的绝对 .exe 路径。']);
   await mkdir(config.codexHome,{recursive:true});
   const exitCode=await runCodexLogin(config.codexExecutable,config.codexHome);
   if(exitCode!==0){console.error(`Codex 登录未成功，退出码 ${exitCode}`);return exitCode||1;}
   if(!await hasCodexLogin(config.codexHome)){console.error('Codex 登录结束，但独立 codexHome 中未发现 auth.json；未读取其内容。');return 1;}
   console.log('Codex 登录完成，独立 CODEX_HOME 中已发现 auth.json（仅检查存在性）。');return 0;
  }
  logger=new Logger(join(stateDir,'logs'),[config.agentKey]);
  for(const warning of warnings)logger.write('warn',warning,true);
  let codexVersion='none';
  if(config.executor==='codex'){
   if(command==='check'){
    const result=await checkCodex(config,line=>logger!.write(line.startsWith('失败')?'error':'info',line,true));
    if(!result.ok)throw new ConfigError(['配置错误：Codex 本机检查未全部通过，请按上方提示修复。']);
    codexVersion=result.version!;
   }else{
    if(!config.codexExecutable||!config.runtimeDir)throw new ConfigError(['配置错误：Codex 运行需要 codexExecutable 和 runtimeDir。']);
    try{codexVersion=await readCodexVersion(config.codexExecutable);}
    catch{throw new ConfigError(['配置错误：无法读取 Codex 版本，请检查 codexExecutable。']);}
    const missing=await missingRuntimeFiles(config.runtimeDir);
    if(missing.length)throw new ConfigError([`配置错误：运行时包缺少 ${missing.join(', ')}，请重新运行 build-runtime。`]);
   }
  }
  let executorVersion=codexVersion;
  if(config.executor==='codebuddy'){
   const {inspectCodeBuddyInstallation,CODEBUDDY_VERSION}=await import('./codebuddy-cli.ts');
   const proxy=await resolveCodexProxy({env:process.env,serverUrl:config.serverUrl,warn:message=>logger!.write('warn',message,true)});
   logger.write('info',`CodeBuddy 代理：${proxy.message}`,true);
   const result=await inspectCodeBuddyInstallation({codebuddyEntry:config.codebuddyEntry!,codebuddyHome:config.codebuddyHome!,runtimeDir:config.runtimeDir!});
   logger.write(result.version===CODEBUDDY_VERSION?'info':'error',`${result.version===CODEBUDDY_VERSION?'通过':'失败'}：CodeBuddy 版本 ${result.version??'无法读取'}，要求 ${CODEBUDDY_VERSION}`,true);
   if(command==='run'&&!result.loggedIn)logger.write('warn','警告：未发现 CodeBuddy 共享登录凭据；成员代理将照常上线，任务会以 member_agent_codebuddy_login_required 失败。请运行 start.ps1 -Mode login 完成登录。',true);
   else logger.write(result.loggedIn?'info':'error',`${result.loggedIn?'通过':'失败'}：共享登录凭据${result.loggedIn?'存在（仅检查存在性）':'不存在，请运行 start.ps1 -Mode login'}`,true);
   for(const [name,issues] of [['安装包清单',result.packageIssues],['运行时',result.runtimeIssues]] as const)logger.write(issues.length?'error':'info',`${issues.length?'失败':'通过'}：${name}${issues.length?'：'+issues.join('；'):'完整'}`,true);
   if(result.version!==CODEBUDDY_VERSION||result.packageIssues.length||result.runtimeIssues.length||(command==='check'&&!result.loggedIn))throw new ConfigError(['配置错误：CodeBuddy 本机检查未全部通过，请按上方提示修复。']);
   executorVersion=result.version!;
  }
  release=await acquireLock(stateDir);
  assertTransportAllowed(config.serverUrl);
  const stop=new AbortController();
  let installDraining=false;
  let sendControl:(frame:import('./protocol.ts').Frame)=>void=()=>{};
  let drain:()=>Promise<boolean>=async()=>true;
  const runner=new JobRunner({serverUrl:config.serverUrl,logger,send:()=>{},echoHoldSec:config.echoHoldSec,
   ...(config.executor==='codebuddy'?{executorUrl:new URL('./executors/codebuddy.ts',import.meta.url),executorData:{codebuddyEntry:config.codebuddyEntry,codebuddyHome:config.codebuddyHome,codebuddyModel:config.codebuddyModel,runtimeDir:config.runtimeDir,projectDirs:config.projectDirs,defaultCwd:config.defaultCwd,configDir:stateDir,proxyWarningState:new SharedArrayBuffer(4)}}:config.executor==='codex'?{executorUrl:new URL('./executors/codex.ts',import.meta.url),executorData:{codexExecutable:config.codexExecutable,codexHome:config.codexHome,runtimeDir:config.runtimeDir,projectDirs:config.projectDirs,defaultCwd:config.defaultCwd,configDir:stateDir,proxyWarningState:new SharedArrayBuffer(4)}}:{})});
  const installControl=command==='run'?await createInstallControl({stateDir,busy:()=>runner.busy,
   onDrain:()=>{installDraining=true;logger!.write('info','安装程序请求停止：等待当前任务完成',true);},
   onStop:async force=>{try{if(force)await runner.shutdown();if(!await drain())logger!.write('warn','升级停止前结果未送达，请在看板核对',true);}finally{stop.abort();}},
  }):undefined;
  const dispose=installInterrupts(process,runner,async()=>{
   try{if(!await drain())logger!.write('warn','退出前结果未能送达服务器，请在看板核对本次运行',true);}finally{stop.abort();}
  },code=>process.exit(code));
  try{
   return await connectLoop({serverUrl:config.serverUrl,agentKey:config.agentKey,version:AGENT_VERSION,codexVersion,executor:config.executor,executorVersion,check:command==='check',signal:stop.signal,logger,
    onSession:(send,flush)=>{runner.setSender(send);sendControl=send;drain=flush;},onDisconnect:()=>runner.disconnect(),onFrame:frame=>{
     if(stop.signal.aborted)return;
     if(frame.type==='job.start'){
      if(installDraining){sendControl({v:1,type:'job.result',jobId:frame.jobId,exitCode:1,signal:null,timedOut:false,errorCode:'member_agent_busy',errorMessage:'成员代理正在等待升级停止，请稍后重试'});return;}
      runner.start(frame as unknown as JobStart);
     }
     else if(frame.type==='job.cancel')return runner.cancel(String(frame.jobId),typeof frame.graceSec==='number'&&Number.isFinite(frame.graceSec)&&frame.graceSec>=0?Math.min(frame.graceSec,20):20);
    }});
  }finally{dispose();try{await installControl?.dispose();}finally{await runner.shutdown();}}
 }catch(error){
  const code=typeof error==='object'&&error!==null&&'code'in error&&[2,5].includes(Number(error.code))?Number(error.code):1;
  const message=error instanceof Error?error.message:'成员代理发生内部错误，请查看日志';
  if(logger)logger.write('error',message,true);else console.error(message);
  return code;
 }finally{await release?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('成员代理发生内部错误，请检查配置和日志');process.exitCode=1;});}
