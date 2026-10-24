import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect,it} from 'vitest';
import {preparePiPromptFiles} from './prompt-files.js';

it('keeps long Unicode prompts out of the Windows command line and removes temporary files', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-prompt-test-'));
  const system='职责与约束\n'.repeat(5000);
  const user='任务\n"$ 不应执行"\n'.repeat(5000);
  try {
    const prepared=await preparePiPromptFiles(root,system,user);
    expect(prepared.systemArg.length + prepared.userArg.length).toBeLessThan(1000);
    expect(prepared.userArg.startsWith('@')).toBe(true);
    expect(await fs.readFile(prepared.systemArg,'utf8')).toBe(system);
    expect(await fs.readFile(prepared.userArg.slice(1),'utf8')).toBe(user);
    await prepared.cleanup();
    expect(await fs.readdir(root)).toEqual([]);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
