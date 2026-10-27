import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { connectLoop, type Clock } from '../src/connection.ts';
import { OutboundQueue } from '../src/outbound-queue.ts';
import { JobRunner } from '../src/job-runner.ts';
import { Logger } from '../src/logger.ts';
import type { JobStart } from '../src/protocol.ts';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 15));
async function until(test: () => boolean) { for(let n=0;n<300;n++){ if(test())return; await flush(); } throw new Error('测试等待超时'); }
class ManualClock implements Clock {
  now = 0;
  random = () => 0;
  entries = new Map<number, {at:number, fn:()=>void}>();
  next = 1;
  setTimeout(fn:()=>void,ms:number) { const id=this.next++; this.entries.set(id,{at:this.now+ms,fn}); return id as unknown as ReturnType<typeof setTimeout>; }
  clearTimeout(id:ReturnType<typeof setTimeout>) { this.entries.delete(id as unknown as number); }
  advance(ms:number) { const target=this.now+ms; while(true){ const due=[...this.entries].filter(([,e])=>e.at<=target).sort((a,b)=>a[1].at-b[1].at)[0]; if(!due)break; this.now=due[1].at;this.entries.delete(due[0]);due[1].fn(); }this.now=target; }
}
async function server(onSocket:(socket:any,request:any)=>void, autoPong = true) {
  const http=createServer(); const wss=new WebSocketServer({server:http,autoPong});
  wss.on('connection',onSocket);http.listen(0,'127.0.0.1');await once(http,'listening');
  cleanup.push(async()=>{ for(const s of wss.clients)s.terminate(); await new Promise<void>(r=>wss.close(()=>http.close(()=>r()))); });
  return `http://127.0.0.1:${(http.address() as any).port}`;
}
function opts(serverUrl:string,extra:Record<string,unknown>={}) {
  const abort=new AbortController();const lines:string[]=[];
  cleanup.push(()=>abort.abort());
  return {serverUrl,agentKey:'FAKE-connection-key',version:'0.2.0',signal:abort.signal,logger:{write:(_level:string,message:string)=>{lines.push(message);}},abort,lines,...extra};
}

describe('连接和重连',()=>{
  it('发送有效 hello 和认证头，check 在 ack 后读取服务器参数并正常退出',async()=>{
    let hello:any,headers:any,url:any;const endpoint=await server((ws,req)=>{headers=req.headers;url=req.url;ws.on('message',(raw:any)=>{hello=JSON.parse(raw.toString());ws.send(JSON.stringify({v:1,type:'hello.ack',heartbeatSec:9,maxRunSec:77,pinnedCodexVersion:'固定版本'}));});});
    const options=opts(endpoint,{check:true});let ack:any;const code=await connectLoop({...options,onReady:value=>{ack=value;}});
    expect(code).toBe(0);expect(url).toBe('/api/member-agent/v1/connect');expect(headers.authorization).toBe('Bearer FAKE-connection-key');
    expect(hello).toMatchObject({v:1,type:'hello',agentVersion:'0.2.0',codexVersion:'none'});
    for(const key of ['agentVersion','codexVersion','hostname','platform']){expect(typeof hello[key]).toBe('string');expect(hello[key].length).toBeGreaterThan(0);expect(hello[key].length).toBeLessThanOrEqual(255);}
    expect(ack.maxRunSec).toBe(77);expect(options.lines.join('\n')).toContain('固定版本');
  });
  it.each([[401,3],[403,4]])('HTTP %i 退出码 %i 且不重试',async(status,expected)=>{
    const http=createServer();let attempts=0;http.on('upgrade',(_req,socket)=>{attempts++;socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);});http.listen(0,'127.0.0.1');await once(http,'listening');cleanup.push(()=>new Promise<void>(r=>http.close(()=>r())));
    const options=opts(`http://127.0.0.1:${(http.address() as any).port}`);expect(await connectLoop(options)).toBe(expected);expect(attempts).toBe(1);
  });
  it('10 秒未收到 hello 响应就关闭，1 秒退避后重连',async()=>{
    const clock=new ManualClock();let attempts=0;const endpoint=await server(()=>{attempts++;});const options=opts(endpoint,{clock});const running=connectLoop(options);
    await until(()=>attempts===1);clock.advance(9999);await flush();expect(attempts).toBe(1);clock.advance(1);await until(()=>options.lines.some(x=>x.includes('重试')));clock.advance(999);await flush();expect(attempts).toBe(1);clock.advance(1);await until(()=>attempts===2);options.abort.abort();expect(await running).toBe(0);
  });
  it('HTTP 429 至少等 60 秒才重试',async()=>{
    const clock=new ManualClock();let attempts=0;const http=createServer();http.on('upgrade',(_req,s)=>{attempts++;s.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});http.listen(0,'127.0.0.1');await once(http,'listening');cleanup.push(()=>new Promise<void>(r=>http.close(()=>r())));
    const options=opts(`http://127.0.0.1:${(http.address() as any).port}`,{clock});const running=connectLoop(options);await until(()=>options.lines.some(x=>x.includes('重试')));clock.advance(59999);await flush();expect(attempts).toBe(1);clock.advance(1);await until(()=>attempts===2);options.abort.abort();expect(await running).toBe(0);
  });
  it('already_connected 每次等 30 秒无限重试，not_allowed 不重试',async()=>{
    const clock=new ManualClock();let attempts=0;const endpoint=await server(ws=>{attempts++;ws.send(JSON.stringify({v:1,type:'hello.reject',code:attempts<4?'already_connected':'member_agent_not_allowed'}));});const options=opts(endpoint,{clock});const running=connectLoop(options);
    for(let n=1;n<=3;n++){await until(()=>options.lines.filter(x=>x.includes('重试')).length===n);clock.advance(29999);await flush();expect(attempts).toBe(n);clock.advance(1);await until(()=>attempts===n+1);}expect(await running).toBe(4);
  });
  it('失败指数退避到 30 秒上限，ack 后重置',async()=>{
    const clock=new ManualClock();let attempts=0;const endpoint=await server(ws=>{attempts++;ws.on('message',()=>{if(attempts===8)ws.send(JSON.stringify({v:1,type:'hello.ack'}));ws.close();});});const options=opts(endpoint,{clock});const running=connectLoop(options);
    for(const [index,delay] of [1000,2000,4000,8000,16000,30000,30000,1000].entries()){await until(()=>options.lines.filter(x=>x.includes('重试')).length===index+1);clock.advance(delay-1);await flush();expect(attempts).toBe(index+1);clock.advance(1);await until(()=>attempts===index+2);}options.abort.abort();expect(await running).toBe(0);
  });
  it('随机抖动在 0–20%，独立心跳按 ack 周期发送',async()=>{
    const clock=new ManualClock();clock.random=()=>0.5;const received:any[]=[];const endpoint=await server(ws=>ws.on('message',(raw:any)=>{const f=JSON.parse(raw.toString());received.push(f);if(f.type==='hello')ws.send(JSON.stringify({v:1,type:'hello.ack',heartbeatSec:2}));}));const options=opts(endpoint,{clock});const running=connectLoop(options);await until(()=>options.lines.some(x=>x.includes('已连接')));clock.advance(1999);await flush();expect(received.filter(x=>x.type==='heartbeat')).toHaveLength(0);clock.advance(1);await until(()=>received.some(x=>x.type==='heartbeat'));options.abort.abort();expect(await running).toBe(0);
    const failing=await server(ws=>ws.close());const retryOpts=opts(failing,{clock});const retry=connectLoop(retryOpts);await until(()=>retryOpts.lines.some(x=>x.includes('重试')));expect(retryOpts.lines.find(x=>x.includes('重试'))).toContain('1.1');retryOpts.abort.abort();await retry;
  });
  it('未知 type 记录日志，未知版本断开，重连等待任务清理且旧 sender 失效',async()=>{
    const clock=new ManualClock();let attempts=0;let first:any;const frames:any[]=[];const endpoint=await server(ws=>{attempts++;ws.on('message',(raw:any)=>{frames.push(JSON.parse(raw.toString()));});ws.send(JSON.stringify({v:1,type:'hello.ack'}));if(attempts===1){first=ws;}});let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});let oldSend:any;const options=opts(endpoint,{clock});const running=connectLoop({...options,onSession:send=>{oldSend??=send;},onDisconnect:()=>barrier});await until(()=>first&&oldSend);first.send(JSON.stringify({v:1,type:'future.message'}));await until(()=>options.lines.some(x=>x.includes('未知')));first.send(JSON.stringify({v:2,type:'job.start'}));await until(()=>options.lines.some(x=>x.includes('版本')));clock.advance(100000);await flush();expect(attempts).toBe(1);release();await until(()=>options.lines.some(x=>x.includes('重试')));clock.advance(1000);await until(()=>attempts===2);oldSend({v:1,type:'job.result',jobId:'old'});await flush();expect(frames.some(x=>x.jobId==='old')).toBe(false);options.abort.abort();await running;
  });
  it('6 执行器在独立 Worker 中同步忙等时，真实 WebSocket 心跳持续发送',async()=>{
    const received:Array<Record<string,unknown>>=[];
    const job:JobStart={v:1,type:'job.start',jobId:'fixture-blocked',companyId:'fixture-company',agent:{id:'fixture-agent',name:'fixture'},authToken:'FAKE-BLOCKED-RUN-TOKEN',context:{},config:{maxRunSec:5},runtime:{},runtimeTools:null,handoffMarkdown:'',codeSyncDir:''};
    const endpoint=await server(ws=>ws.on('message',(raw:Buffer)=>{
      const frame=JSON.parse(raw.toString());received.push(frame);
      if(frame.type==='hello'){
        ws.send(JSON.stringify({v:1,type:'hello.ack',heartbeatSec:0.05}));
        ws.send(JSON.stringify(job));
      }
    }));
    const dir=mkdtempSync(join(tmpdir(),'member-heartbeat-'));
    const logger=new Logger(dir,['FAKE-connection-key'],()=>{});
    const runner=new JobRunner({serverUrl:endpoint,logger,send:()=>{},executorUrl:new URL('./fixtures/executor.ts',import.meta.url),executorData:{mode:'blocked'}});
    cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
    cleanup.push(()=>runner.shutdown());
    const options=opts(endpoint);
    const running=connectLoop({...options,logger,onSession:send=>runner.setSender(send),onFrame:frame=>runner.start(frame as unknown as JobStart),onDisconnect:()=>runner.disconnect()});
    await until(()=>received.some(f=>f.type==='job.accepted'));
    await until(()=>received.filter(f=>f.type==='heartbeat').length>=4);
    expect(received.some(f=>f.type==='job.result')).toBe(false);
    await until(()=>received.some(f=>f.type==='job.result'));
    expect(received.filter(f=>f.type==='heartbeat').length).toBeGreaterThan(3);
    options.abort.abort();expect(await running).toBe(0);
  });
  it('原生 pong 无响应满 45 秒中止任务并退避重连，不依赖应用心跳 ack',async()=>{
    const clock=new ManualClock();let attempts=0,pings=0,disconnects=0;const received:Array<Record<string,unknown>>=[];
    const job:JobStart={v:1,type:'job.start',jobId:'fixture-half-open',companyId:'fixture-company',agent:{id:'fixture-agent',name:'fixture'},authToken:'FAKE-HALF-OPEN-TOKEN',context:{},config:{maxRunSec:120},runtime:{},runtimeTools:null,handoffMarkdown:'',codeSyncDir:''};
    const endpoint=await server(ws=>{
      attempts++;ws.on('ping',()=>{pings++;});
      ws.on('message',(raw:Buffer)=>{const frame=JSON.parse(raw.toString());received.push(frame);if(frame.type==='hello'){ws.send(JSON.stringify({v:1,type:'hello.ack',heartbeatSec:60}));if(attempts===1)ws.send(JSON.stringify(job));}});
    },false);
    const dir=mkdtempSync(join(tmpdir(),'member-half-open-'));const logger=new Logger(dir,['FAKE-connection-key'],()=>{});
    const runner=new JobRunner({serverUrl:endpoint,logger,send:()=>{},executorUrl:new URL('./fixtures/executor.ts',import.meta.url),executorData:{mode:'wait'}});
    cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));cleanup.push(()=>runner.shutdown());
    const options=opts(endpoint,{clock});const running=connectLoop({...options,logger,onSession:send=>runner.setSender(send),onFrame:frame=>runner.start(frame as unknown as JobStart),onDisconnect:async()=>{disconnects++;await runner.disconnect();}});
    await until(()=>received.some(f=>f.type==='job.accepted'));expect(runner.busy).toBe(true);
    clock.advance(44999);await flush();expect(disconnects).toBe(0);expect(attempts).toBe(1);expect(pings).toBeGreaterThan(0);
    clock.advance(1);await until(()=>disconnects===1&&!runner.busy);expect(received.some(f=>f.type==='job.result')).toBe(false);
    // Cleanup is awaited before retry's independent one-second backoff starts.
    await flush();clock.advance(999);await flush();expect(attempts).toBe(1);clock.advance(1);await until(()=>attempts===2);
    options.abort.abort();expect(await running).toBe(0);
  });
  it('原生自动 pong 保持连接，不要求服务器回复 JSON heartbeat',async()=>{
    const clock=new ManualClock();let attempts=0,pings=0,heartbeats=0,disconnects=0;
    const endpoint=await server(ws=>{attempts++;ws.on('ping',()=>{pings++;});ws.on('message',(raw:Buffer)=>{const frame=JSON.parse(raw.toString());if(frame.type==='hello')ws.send(JSON.stringify({v:1,type:'hello.ack',heartbeatSec:15}));if(frame.type==='heartbeat')heartbeats++;});});
    const options=opts(endpoint,{clock});const running=connectLoop({...options,onDisconnect:async()=>{disconnects++;}});
    await until(()=>options.lines.some(line=>line.includes('已连接')));
    for(let n=0;n<4;n++){clock.advance(15000);await flush();}
    expect(pings).toBeGreaterThan(0);expect(heartbeats).toBeGreaterThanOrEqual(4);expect(disconnects).toBe(0);expect(attempts).toBe(1);
    options.abort.abort();expect(await running).toBe(0);
  });
});

describe('有界发送队列',()=>{
  it('超过1000帧只丢弃最旧日志，保留结果且发送回调继续排空',()=>{
    const sent:any[]=[];const callbacks:Array<(error?:Error)=>void>=[];const notices:string[]=[];
    const socket={readyState:1,bufferedAmount:0,send(text:string,cb:(error?:Error)=>void){sent.push(JSON.parse(text));callbacks.push(cb);}};
    const queue=new OutboundQueue(socket,{onDrop:n=>notices.push(`已丢弃 ${n} 条输出`)});
    for(let seq=1;seq<=1200;seq++)queue.send({v:1,type:'job.log',jobId:'j',seq,stream:'stdout',chunk:'输出'});
    queue.send({v:1,type:'job.result',jobId:'j',exitCode:0,signal:null,timedOut:false});
    while(callbacks.length)callbacks.shift()!();
    expect(sent.length).toBeLessThanOrEqual(1001);expect(sent[0].seq).toBe(1);expect(sent.find(x=>x.seq===2)).toBeUndefined();expect(sent.at(-1).type).toBe('job.result');expect(notices.length).toBeGreaterThan(0);queue.close();
  });
  it('8MiB 字节上限生效，停止后丢弃后续输出',()=>{
    const sent:any[]=[];const callbacks:Array<()=>void>=[];const socket={readyState:1,bufferedAmount:0,send(text:string,cb:()=>void){sent.push(JSON.parse(text));callbacks.push(cb);}};
    const queue=new OutboundQueue(socket);for(let seq=1;seq<=400;seq++)queue.send({v:1,type:'job.log',jobId:'j',seq,stream:'stdout',chunk:'a'.repeat(32768)});queue.send({v:1,type:'job.result',jobId:'j',exitCode:0,signal:null,timedOut:false});while(callbacks.length)callbacks.shift()!();expect(sent.length).toBeLessThan(260);expect(sent.at(-1).type).toBe('job.result');queue.close();const size=sent.length;queue.send({v:1,type:'heartbeat'});expect(sent.length).toBe(size);
  });
  it('ws 缓冲区积压时暂缓发送，并在缓冲释放后恢复',()=>{
    const clock=new ManualClock();const sent:string[]=[];
    const socket={readyState:1,bufferedAmount:300_000,send(text:string,cb:()=>void){sent.push(text);cb();}};
    const queue=new OutboundQueue(socket,{clock});queue.send({v:1,type:'heartbeat'});
    expect(sent).toHaveLength(0);clock.advance(49);expect(sent).toHaveLength(0);
    socket.bufferedAmount=0;clock.advance(1);expect(JSON.parse(sent[0]!)).toMatchObject({type:'heartbeat'});queue.close();
  });
  it('drain 等待积压日志和结果的发送回调后才成功，结果不丢失',async()=>{
    const sent:Array<Record<string,unknown>>=[];const callbacks:Array<()=>void>=[];
    const socket={readyState:1,bufferedAmount:0,send(text:string,cb:()=>void){sent.push(JSON.parse(text));callbacks.push(cb);}};
    const queue=new OutboundQueue(socket);
    queue.send({v:1,type:'job.log',jobId:'j',seq:1,stream:'stdout',chunk:'输出'});
    queue.send({v:1,type:'job.result',jobId:'j',exitCode:0,signal:null,timedOut:false});
    let finished=false;const drained=queue.drain().then(value=>{finished=true;return value;});
    await Promise.resolve();expect(finished).toBe(false);expect(sent.map(frame=>frame.type)).toEqual(['job.log']);
    callbacks.shift()!();await Promise.resolve();expect(finished).toBe(false);expect(sent.map(frame=>frame.type)).toEqual(['job.log','job.result']);
    callbacks.shift()!();expect(await drained).toBe(true);queue.close();
  });
  it('drain 发送超时或队列关闭时返回 false，无积压时立即返回 true',async()=>{
    const clock=new ManualClock();const socket={readyState:1,bufferedAmount:0,send(_text:string,_cb:()=>void){}};
    const queue=new OutboundQueue(socket,{clock});expect(await queue.drain()).toBe(true);
    queue.send({v:1,type:'job.result',jobId:'j',exitCode:0,signal:null,timedOut:false});
    let finished=false;const timeout=queue.drain(100).then(value=>{finished=true;return value;});
    clock.advance(99);await Promise.resolve();expect(finished).toBe(false);clock.advance(1);expect(await timeout).toBe(false);
    const closed=queue.drain();queue.close();expect(await closed).toBe(false);expect(await queue.drain()).toBe(false);expect(clock.entries.size).toBe(0);
  });
});
