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
import { AGENT_VERSION } from './executors/echo.ts';
import type { JobStart } from './protocol.ts';
import { hasCodexLogin, inspectCodexInstallation, isCodexExecutableReady, missingRuntimeFiles, readCodexVersion, runCodexLogin } from './codex-cli.ts';

export function installInterrupts(signals:Pick<EventEmitter,'on'|'off'>,runner:{shutdown:()=>Promise<void>;force:()=>void|Promise<void>},close:()=>void|Promise<void>,exit:(code:number)=>void){
 let count=0;
 const handle=()=>{if(++count>1){try{const forced=runner.force();if(forced&&typeof (forced as Promise<void>).then==='function')void Promise.resolve(forced).then(()=>exit(0),()=>exit(0));else exit(0);}catch{exit(0);}return;}void runner.shutdown().catch(()=>{}).then(close).catch(()=>{});};
 signals.on('SIGINT',handle);
 return ()=>{signals.off('SIGINT',handle);};
}
const usage='用法：node member-agent/src/main.ts run|check|login [--config <文件>]，或 version';
async function checkCodex(config:Awaited<ReturnType<typeof loadConfig>>,print:(line:string)=>void):Promise<{ok:boolean;version:string|null}>{
 const result=await inspectCodexInstallation({executable:config.codexExecutable??'',codexHome:config.codexHome??'',runtimeDir:config.runtimeDir??''});
 print(`${result.executable?'通过':'失败'}：Codex 可执行文件${result.executable?'存在':'不存在或不是 .exe'}`);
 print(`${result.version?'通过':'失败'}：${result.version?`Codex 版本 ${result.version}`:'无法读取 Codex 版本'}`);
 print(`${result.loggedIn?'通过':'失败'}：Codex 登录凭据${result.loggedIn?'已存在':'不存在，请先运行 login'}`);
 print(`${result.missingRuntime.length===0?'通过':'失败'}：运行时包${result.missingRuntime.length===0?'完整':`缺少 ${result.missingRuntime.join(', ')}`}；如需重建，请运行 build-runtime`);
 return {ok:result.executable&&!!result.version&&result.loggedIn&&result.missingRuntime.length===0,version:result.version};
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
  release=await acquireLock(stateDir);
  assertTransportAllowed(config.serverUrl);
  const stop=new AbortController();
  let drain:()=>Promise<boolean>=async()=>true;
  const runner=new JobRunner({serverUrl:config.serverUrl,logger,send:()=>{},echoHoldSec:config.echoHoldSec,
   ...(config.executor==='codex'?{executorUrl:new URL('./executors/codex.ts',import.meta.url),executorData:{codexExecutable:config.codexExecutable,codexHome:config.codexHome,runtimeDir:config.runtimeDir,projectDirs:config.projectDirs,defaultCwd:config.defaultCwd,configDir:stateDir}}:{})});
  const dispose=installInterrupts(process,runner,async()=>{
   try{if(!await drain())logger!.write('warn','退出前结果未能送达服务器，请在看板核对本次运行',true);}finally{stop.abort();}
  },code=>process.exit(code));
  try{
   return await connectLoop({serverUrl:config.serverUrl,agentKey:config.agentKey,version:AGENT_VERSION,codexVersion,check:command==='check',signal:stop.signal,logger,
    onSession:(send,flush)=>{runner.setSender(send);drain=flush;},onDisconnect:()=>runner.disconnect(),onFrame:frame=>{
     if(stop.signal.aborted)return;
     if(frame.type==='job.start')runner.start(frame as unknown as JobStart);
     else if(frame.type==='job.cancel')return runner.cancel(String(frame.jobId),typeof frame.graceSec==='number'&&Number.isFinite(frame.graceSec)&&frame.graceSec>=0?Math.min(frame.graceSec,20):20);
    }});
  }finally{dispose();await runner.shutdown();}
 }catch(error){
  const code=typeof error==='object'&&error!==null&&'code'in error&&[2,5].includes(Number(error.code))?Number(error.code):1;
  const message=error instanceof Error?error.message:'成员代理发生内部错误，请查看日志';
  if(logger)logger.write('error',message,true);else console.error(message);
  return code;
 }finally{await release?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){void main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('成员代理发生内部错误，请检查配置和日志');process.exitCode=1;});}
