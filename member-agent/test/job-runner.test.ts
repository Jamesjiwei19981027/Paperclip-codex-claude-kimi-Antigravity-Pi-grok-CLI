import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRunner } from '../src/job-runner.ts';
import { Logger } from '../src/logger.ts';
import type { JobStart } from '../src/protocol.ts';

const dirs:string[]=[];
const runners:JobRunner[]=[];
afterEach(async()=>{ for(const r of runners.splice(0)) await r.shutdown(); for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true}); });
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('等待测试任务超时');await pause(10);}}
function job(id='fixture-job',maxRunSec=4):JobStart{return {v:1,type:'job.start',jobId:id,companyId:'fixture-company',agent:{id:'fixture-agent',name:'fixture'},authToken:'FAKE-RUN-TOKEN-ONLY-FOR-TESTS',config:{maxRunSec},context:{},runtime:{},runtimeTools:{bearerToken:'FAKE-TOOL-TOKEN-ONLY-FOR-TESTS'},handoffMarkdown:''} as JobStart;}
function setup(mode='normal'){
 const dir=mkdtempSync(join(tmpdir(),'member-runner-'));dirs.push(dir);const frames:Record<string,any>[]=[];const visible:string[]=[];
 const logger=new Logger(dir,['FAKE-AGENT-KEY-ONLY-FOR-TESTS'],s=>visible.push(s));
 const runner=new JobRunner({serverUrl:'http://127.0.0.1:1',logger,send:f=>frames.push(f),executorUrl:new URL('./fixtures/executor.ts',import.meta.url),executorData:{mode}});runners.push(runner);return {runner,frames,dir,visible};
}
describe('阶段2任务执行器隔离',()=>{
 it.each([
  ['error-code','失败（member_agent_codebuddy_login_required）'],
  ['timed-out','失败'],
  ['nonzero','失败'],
  ['normal','成功'],
 ])('logs the same outcome as the server for %s',async(mode,outcome)=>{
  const {runner,frames,visible}=setup(mode);runner.start(job());await until(()=>frames.some(f=>f.type==='job.result'));
  expect(visible.find(line=>line.includes('任务结束 fixture-job：'))).toContain(`任务结束 fixture-job：${outcome}`);
  if(mode==='error-code')expect(frames.find(f=>f.type==='job.result')).toMatchObject({exitCode:0,errorCode:'member_agent_codebuddy_login_required'});
 });
 it('7 accepts before preparation, numbers logs and events independently, and emits one result',async()=>{
  const {runner,frames}=setup();runner.start(job());expect(frames[0]?.type).toBe('job.accepted');await until(()=>frames.some(f=>f.type==='job.result'));
  expect(frames.filter(f=>f.type==='job.result')).toHaveLength(1);expect(frames.filter(f=>f.type==='job.log').map(f=>f.seq)).toEqual([1,2]);expect(frames.filter(f=>f.type==='job.event').map(f=>f.seq)).toEqual([1]);
 });
 it('8 refuses a second job without affecting the running task',async()=>{
  const {runner,frames}=setup('wait');runner.start(job());runner.start(job('fixture-second'));expect(frames.find(f=>f.jobId==='fixture-second')?.errorCode).toBe('member_agent_busy');expect(frames.filter(f=>f.type==='job.accepted')).toHaveLength(1);await runner.cancel('fixture-job',1);
 });
 it('9 cancellation ends within grace and ignores foreign cancellation',async()=>{
  const {runner,frames}=setup('wait');runner.start(job());await runner.cancel('other-job',1);expect(runner.busy).toBe(true);const started=Date.now();await runner.cancel('fixture-job',1);expect(Date.now()-started).toBeLessThan(1100);expect(frames.find(f=>f.type==='job.result')).toMatchObject({errorCode:'cancelled',exitCode:1});
 });
 it('10 enforces a local maxRunSec and aborts the executor',async()=>{
  const {runner,frames}=setup('wait');runner.start(job('fixture-timeout',1));await until(()=>frames.some(f=>f.type==='job.result'));expect(frames.find(f=>f.type==='job.result')).toMatchObject({timedOut:true,errorCode:'member_agent_timeout'});
 });
 it('11 discards disconnected task output and never replays results through a new sender',async()=>{
  const {runner,frames}=setup('wait');runner.start(job());await runner.disconnect();runner.setSender(f=>frames.push(f));await pause(50);expect(frames.some(f=>f.type==='job.result')).toBe(false);expect(runner.busy).toBe(false);
 });
 it('13 turns an unknown executor result field into a protocol safe failure',async()=>{
  const {runner,frames}=setup('invalid');runner.start(job());await until(()=>frames.some(f=>f.type==='job.result'));const result=frames.find(f=>f.type==='job.result');expect(result?.errorCode).toBe('member_agent_executor_error');expect(result).not.toHaveProperty('unexpected');
 });
 it('14 scans console, log files and all outgoing frames for every fake credential',async()=>{
  const {runner,frames,dir,visible}=setup('secret');runner.start(job());await until(()=>frames.some(f=>f.type==='job.result'));const output=JSON.stringify({visible,frames,files:readdirSync(dir).map(n=>readFileSync(join(dir,n),'utf8'))});for(const secret of ['FAKE-AGENT-KEY-ONLY-FOR-TESTS','FAKE-RUN-TOKEN-ONLY-FOR-TESTS','FAKE-TOOL-TOKEN-ONLY-FOR-TESTS'])expect(output).not.toContain(secret);
 });
 it('9 forcibly stops a synchronous blocked executor within grace',async()=>{
  const {runner,frames}=setup('blocked');runner.start(job());await pause(200);await runner.cancel('fixture-job',0.1);expect(frames.find(f=>f.type==='job.result')?.errorCode).toBe('cancelled');expect(runner.busy).toBe(false);
 });
 it('14 does not leak a credential prefix from a truncated exception',async()=>{
  const {runner,frames}=setup('throw-secret');runner.start(job());await until(()=>frames.some(f=>f.type==='job.result'));expect(JSON.stringify(frames)).not.toContain('FAKE-RUN');expect(frames.find(f=>f.type==='job.result')?.errorCode).toBe('member_agent_executor_error');
 });
 it('14 redacts structured strings safely when a credential contains JSON syntax',async()=>{
  const {runner,frames}=setup('secret');const input=job();input.authToken='"abc-FAKE-JSON-SECRET';runner.start(input);await until(()=>frames.some(f=>f.type==='job.result'));expect(JSON.stringify(frames)).not.toContain('FAKE-JSON-SECRET');expect(runner.busy).toBe(false);expect(frames.filter(f=>f.type==='job.result')).toHaveLength(1);
 });
 it('7 settles a returned result even when the executor left a live timer',async()=>{
  const {runner,frames}=setup('live-handle');runner.start(job());await until(()=>frames.some(f=>f.type==='job.result'));expect(frames.find(f=>f.type==='job.result')?.exitCode).toBe(0);expect(runner.busy).toBe(false);
 });
 it('9 releases a task when local logging fails before worker creation',async()=>{
  const {runner,frames}=setup();(runner as any).options.logger.write=()=>{throw Error('fixture disk unavailable');};runner.start(job());await runner.shutdown();expect(runner.busy).toBe(false);expect(frames.filter(f=>f.type==='job.result')).toHaveLength(1);expect(frames.find(f=>f.type==='job.result')?.exitCode).toBe(1);
 });
});
