import { describe,it,expect,vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { installInterrupts } from '../src/main.ts';
describe('成员命令与退出',()=>{
 it('17 first Ctrl+C drains before closing, second Ctrl+C forces exit',async()=>{
  const signals=new EventEmitter();let done!:()=>void;const pending=new Promise<void>(r=>{done=r;});const order:string[]=[];const exit=vi.fn();
  const dispose=installInterrupts(signals,{shutdown:async()=>{order.push('drain');await pending;},force:()=>{order.push('force');}},()=>{order.push('close');},exit);
  signals.emit('SIGINT');expect(order).toEqual(['drain']);signals.emit('SIGINT');expect(order).toEqual(['drain','force']);expect(exit).toHaveBeenCalledWith(0);done();await new Promise(resolve=>setImmediate(resolve));expect(order).toContain('close');dispose();
 });
 it('17 first Ctrl+C gracefully closes after a completed cancellation',async()=>{
  const signals=new EventEmitter();const order:string[]=[];const dispose=installInterrupts(signals,{shutdown:async()=>{order.push('cancelled');},force:()=>{order.push('force');}},()=>{order.push('closed');},()=>{});signals.emit('SIGINT');await Promise.resolve();await Promise.resolve();expect(order).toEqual(['cancelled','closed']);dispose();
 });
 it('native Node runs version and rejects unknown arguments without a build',()=>{
  const version=spawnSync(process.execPath,['src/main.ts','version'],{cwd:process.cwd(),encoding:'utf8'});expect(version.status,version.stderr).toBe(0);expect(version.stdout).toContain('0.2.2');
  for(const args of [['unknown'],['version','--unknown'],['check','--config']]){const r=spawnSync(process.execPath,['src/main.ts',...args],{cwd:process.cwd(),encoding:'utf8'});expect(r.status,r.stderr).toBe(2);expect(r.stderr).toContain('用法');}
 });
});
