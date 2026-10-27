import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {expect,it} from 'vitest';

it('a real agent completes its active job before an installer drain closes the connection',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'member-install-drain-'));
 const http=createServer();const wss=new WebSocketServer({server:http});
 http.listen(0,'127.0.0.1');await once(http,'listening');
 const endpoint=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
 const cfg=path.join(dir,'config.json');
 await fs.writeFile(cfg,JSON.stringify({serverUrl:endpoint,executor:'echo',projectDirs:{},defaultCwd:'',echoHoldSec:2}));
 const state=path.join(dir,'paperclip-member-agent');
 const frames:any[]=[];let socket:any;
 wss.on('connection',ws=>{socket=ws;ws.on('message',raw=>{
  const f=JSON.parse(raw.toString());frames.push(f);
  if(f.type==='hello'){
   ws.send(JSON.stringify({v:1,type:'hello.ack',heartbeatSec:15,maxRunSec:10,pinnedCodexVersion:'0.160.0',minimumAgentVersion:'0.2.0'}));
   ws.send(JSON.stringify({v:1,type:'job.start',jobId:'FAKE-DRAIN-JOB',companyId:'FAKE-COMPANY',agent:{id:'FAKE-AGENT',name:'fake'},authToken:'FAKE-NOT-A-CREDENTIAL',context:{},config:{maxRunSec:10},runtime:{},runtimeTools:null,handoffMarkdown:'',codeSyncDir:''}));
  }
 });});
 const env={...process.env,APPDATA:dir,LOCALAPPDATA:dir,USERPROFILE:dir,HOME:dir,CODEX_HOME:path.join(dir,'codex-home-fake'),PAPERCLIP_AGENT_KEY:'FAKE-NOT-A-CREDENTIAL'};
 const child=spawn(process.execPath,['src/main.ts','run','--config',cfg],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 const exited=once(child,'exit');let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 try{
  await expect.poll(()=>frames.some(f=>f.type==='job.accepted'),{timeout:5000}).toBe(true);
  const identity=JSON.parse(await fs.readFile(path.join(state,'agent-control.json'),'utf8'));
  await fs.writeFile(path.join(state,'launcher-stop.request'),JSON.stringify({...identity,force:false}));
  await expect.poll(()=>output.includes('等待当前任务完成'),{timeout:2000}).toBe(true);
  expect(frames.some(f=>f.type==='job.result')).toBe(false);
  await expect.poll(()=>frames.some(f=>f.type==='job.result'),{timeout:5000}).toBe(true);
  expect(frames.find(f=>f.type==='job.result')).toMatchObject({jobId:'FAKE-DRAIN-JOB',exitCode:0,timedOut:false});
  let deadline:ReturnType<typeof setTimeout>|undefined;
  const [code]=await Promise.race([exited,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Agent did not exit after drain')),5000);})]).finally(()=>clearTimeout(deadline));expect(code,output).toBe(0);
  await expect(fs.stat(path.join(state,'agent-control.json'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{
  if(child.exitCode===null){child.kill();await exited;}
  socket?.terminate();await new Promise<void>(r=>wss.close(()=>http.close(()=>r())));
  await fs.rm(dir,{recursive:true,force:true});
 }
},15000);
