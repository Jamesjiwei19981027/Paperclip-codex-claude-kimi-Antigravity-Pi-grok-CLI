import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

interface Identity { pid: number; startedAt: string }
interface Options {
 stateDir: string;
 busy: () => boolean;
 onDrain: () => void;
 onStop: (force: boolean) => Promise<void>;
}

// Local upgrade coordination only; files carry no credentials. The installer
// restricts this directory to the current Windows user before starting the agent.
export async function createInstallControl(options: Options) {
 let startedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
 if(process.platform==='win32'){
  try{
   const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`],{encoding:'utf8',windowsHide:true,timeout:10000});
   startedAt=new Date(stdout.trim()).toISOString();
  }catch{throw new Error('无法核对本机代理进程身份，请确认 Windows PowerShell 可用后重试。');}
 }
 const identity: Identity = { pid: process.pid, startedAt };
 const file=path.join(options.stateDir,'agent-control.json');
 const request=path.join(options.stateDir,'launcher-stop.request');
 await mkdir(options.stateDir,{recursive:true});
 await writeFile(file,JSON.stringify(identity),'utf8');
 let draining=false,finished=false,polling=false,disposed=false;
 const matches=(value:unknown):value is Identity=>!!value&&typeof value==='object'
  &&(value as Identity).pid===identity.pid&&(value as Identity).startedAt===identity.startedAt;
 async function poll() {
  if(polling||disposed||finished)return;
  polling=true;
  try {
   let value:unknown;
   try{value=JSON.parse(await readFile(request,'utf8'));}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return;throw error;}
   if(!matches(value)||!('force' in value)||typeof value.force!=='boolean')return;
   if(!draining){draining=true;options.onDrain();}
   if(value.force||!options.busy()){
    finished=true;
    await options.onStop(value.force);
   }
  } finally {polling=false;}
 }
 const timer=setInterval(()=>{void poll().catch(()=>{/* A later poll can read an atomically replaced request. */});},250);
 timer.unref();
 async function dispose() {
  disposed=true;clearInterval(timer);
  for(const name of [file,request]){
   try{if(matches(JSON.parse(await readFile(name,'utf8'))))await unlink(name);}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  }
 }
 return {poll,dispose};
}
