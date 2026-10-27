import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const source='E:/workspace/paperclip-member-agent-dev', target='D:/paperclip';
const evidence=path.join(source,'doc/plans/2026-10-27-member-agent-s7-final-evidence');
const backup='E:/AI_Data/backups/paperclip/2026-10-27-before-s7-fix';
const files=['member-agent/src/executors/codex.ts','member-agent/test/codex-executor.test.ts','member-agent/test/codex-integration.test.ts','server/src/routes/agents.ts','server/src/__tests__/agent-permissions-routes.test.ts','server/src/adapters/member-agent/execute.ts','server/src/adapters/member-agent/protocol.test.ts','server/src/services/agent-configuration.ts','server/src/__tests__/member-agent-concurrency.test.ts'];
function run(cwd,args){const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout;}
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
async function copy(from,to){await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);}
await fs.mkdir(backup,{recursive:true});
if(await fs.stat(path.join(backup,'sync-manifest.json')).then(()=>true,()=>false))throw Error('Backup already exists; inspect before rerunning');
const net=spawnSync('netstat',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true});
if(net.status!==0||/^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):3100\s+.*LISTENING/gm.test(net.stdout))throw Error('Local 3100 listening or netstat failed');
await fs.writeFile(path.join(backup,'local-3100-before.txt'),'netstat: no local TCP 3100 listener\n');
await fs.writeFile(path.join(backup,'git-status-before.txt'),run(target,['status','--porcelain']));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'paperclip-s7-patch-'));
run(temp,['init','--quiet']);
const manifest=[];
for(const relative of files){const d=path.join(target,relative),e=path.join(source,relative);const exists=await fs.stat(d).then(()=>true,()=>false);if(exists){await copy(d,path.join(temp,relative));await copy(d,path.join(backup,'files',relative));}manifest.push({path:relative,existed:exists,beforeSha256:exists?await hash(d):null,expectedSha256:await hash(e)});}
run(temp,['add','.']);
for(const relative of files)await copy(path.join(source,relative),path.join(temp,relative));
run(temp,['add','-N','.']);
const patch=path.join(evidence,'member-agent-s7-final.patch');
run(temp,['diff','--binary','--output='+patch]);
const check=await fs.mkdtemp(path.join(os.tmpdir(),'paperclip-s7-apply-check-'));
run(check,['init','--quiet']);
for(const item of manifest)if(item.existed)await copy(path.join(target,item.path),path.join(check,item.path));
run(check,['apply','--check',patch]);
await fs.writeFile(path.join(evidence,'patch-check.json'),JSON.stringify({patch,tempSnapshot:check,files:manifest.map(x=>x.path),checkExit:0,output:'git apply --check: exit 0 (no output)'},null,2));
await fs.writeFile(path.join(backup,'sync-manifest.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(backup,'sha256-manifest.txt'),manifest.map(x=>`${x.beforeSha256??'NEW FILE'}  ${x.path}`).join('\n')+'\n');
run(target,['apply','--check',patch]);
run(target,['apply',patch]);
const comparisons=[];
for(const item of manifest){const actual=await hash(path.join(target,item.path));if(actual!==item.expectedSha256)throw Error('Mismatch '+item.path);comparisons.push({path:item.path,sha256:actual,equal:true});}
await fs.writeFile(path.join(backup,'file-comparison.json'),JSON.stringify(comparisons,null,2));
await fs.writeFile(path.join(backup,'git-apply-check.txt'),'git apply --check: exit 0, no output\ngit apply: exit 0, no output\n');
await fs.writeFile(path.join(backup,'git-status-after-patch.txt'),run(target,['status','--porcelain']));
console.log(JSON.stringify({patch,backup,matched:comparisons.length,check:'passed'}));
