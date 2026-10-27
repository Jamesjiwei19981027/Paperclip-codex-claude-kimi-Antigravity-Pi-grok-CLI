import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createInstallControl } from '../src/install-control.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture() {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'member-install-control-'));
 cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
 let busy=true;
 const drain=vi.fn(); const stop=vi.fn(async (_force:boolean)=>{});
 const control=await createInstallControl({stateDir:dir,busy:()=>busy,onDrain:drain,onStop:stop});
 cleanups.push(control.dispose);
 const identity=JSON.parse(await fs.readFile(path.join(dir,'agent-control.json'),'utf8'));
 const request=async (values:Record<string,unknown>)=>fs.writeFile(path.join(dir,'launcher-stop.request'),JSON.stringify(values));
 return {dir,control,identity,drain,stop,request,setBusy:(value:boolean)=>{busy=value;}};
}
it('drains the active job before stopping and publishes a non-secret process identity',async()=>{
 const f=await fixture();
 expect(f.identity).toEqual({pid:process.pid,startedAt:expect.stringMatching(/^\d{4}-.*Z$/)});
 await f.request({...f.identity,force:false});await f.control.poll();
 expect(f.drain).toHaveBeenCalledOnce();expect(f.stop).not.toHaveBeenCalled();
 f.setBusy(false);await f.control.poll();await f.control.poll();
 expect(f.stop).toHaveBeenCalledExactlyOnceWith(false);
});
it('ignores a stale process identity and only honors a matching force request',async()=>{
 const f=await fixture();
 await f.request({...f.identity,startedAt:'2000-01-01T00:00:00.000Z',force:true});await f.control.poll();
 expect(f.drain).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled();
 await f.request({...f.identity,force:true});await f.control.poll();
 expect(f.drain).toHaveBeenCalledOnce();expect(f.stop).toHaveBeenCalledExactlyOnceWith(true);
});
it('removes owned control files on exit and does not remove another instance identity',async()=>{
 const f=await fixture();await f.control.dispose();
 await expect(fs.stat(path.join(f.dir,'agent-control.json'))).rejects.toMatchObject({code:'ENOENT'});
 const other={pid:42,startedAt:'2000-01-01T00:00:00.000Z'};
 await fs.writeFile(path.join(f.dir,'agent-control.json'),JSON.stringify(other));
 await f.control.dispose();expect(JSON.parse(await fs.readFile(path.join(f.dir,'agent-control.json'),'utf8'))).toEqual(other);
});
it.skipIf(process.platform!=='win32')('uses the Windows process creation time rather than Node initialization time',async()=>{
 const f=await fixture();
 const actual=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`],{encoding:'utf8',windowsHide:true}).trim();
 expect(Math.abs(Date.parse(actual)-Date.parse(f.identity.startedAt))).toBeLessThan(2);
});
