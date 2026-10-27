import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root='E:/workspace/paperclip-member-agent-dev',target='D:/paperclip';
const relative='doc/plans/2026-10-27-member-agent-s7-final-evidence',evidence=path.join(root,relative);
const backup='E:/AI_Data/backups/paperclip/2026-10-27-before-s7-fix';
const result=JSON.parse(await fs.readFile(path.join(evidence,'ssh-queue/006-switch.result.json'),'utf8'));
if(result.exit!==0)throw Error('Deployment needs failure review');
const deployed=JSON.parse(result.stdout);
if(!deployed.deployed||!deployed.dbUnchanged||deployed.memberNoKeyHttpStatus!==401||deployed.health.status!=='ok'||deployed.health.deploymentMode!=='authenticated')throw Error('Post-deployment checks failed');
await fs.writeFile(path.join(evidence,'deployment-result.json'),JSON.stringify(deployed,null,2));
for(const item of ['001-preflight','002-active-source','003-backup','005-build','006-switch']){
 const r=JSON.parse(await fs.readFile(path.join(evidence,'ssh-queue',item+'.result.json'),'utf8'));
 await fs.writeFile(path.join(evidence,item+'.stdout.log'),r.stdout??'');
 await fs.writeFile(path.join(evidence,item+'.stderr.log'),r.stderr??'');
}
const report=path.join(evidence,'report.md');
await fs.appendFile(report,`\n## 第三部分：实际部署结果\n\n负责人已于 2026-10-27 11:57 北京时间通过已登录看板只读确认无活动运行。本轮没有操作浏览器。切换开始时间：${deployed.cutoverStartedAt}，在三十分钟窗口内。\n\n仅同步 server/src/routes/agents.ts、server/src/services/agent-configuration.ts、server/src/adapters/member-agent/execute.ts 三个文件；无 packages 改动。未上传 company-setup、本机脚本、doc 或配置。运行镜像原来包含 B3，但默认构建源码 execute.ts 仍是 B3 前版本；此次最终 execute.ts 同时保留 B3 与 S7。服务器生产源码与 D 盘对应文件哈希一致。\n\n使用 docker compose 5.4.0 构建；候选镜像三个源文件 SHA-256 已核对。只使用 up -d --no-deps --no-build --force-recreate server 切换应用，未重建数据库容器。备份镜像：${deployed.rollbackTag}。源码备份：${deployed.sourceBackup}，校验值见 003-backup.stdout.log。\n\n部署后 health HTTP ${deployed.health.httpStatus} / status=${deployed.health.status} / deploymentMode=${deployed.health.deploymentMode}；无 Key 的成员 WebSocket 升级返回 ${deployed.memberNoKeyHttpStatus}。数据库容器 ID ${deployed.dbAfter.id}，启动时间 ${deployed.dbAfter.startedAt}，与部署前完全一致。应用镜像 ${deployed.appAfter.imageId}；容器 ${deployed.appAfter.id}。\n\n部署成功，未触发回滚。没有修改测试智能体配置、派发或取消任何任务；未读取真实成员配置/凭据，未停止本地成员代理，未修改 runtime。S7 真实复验由负责人执行；共享恢复提示原生工具名仍按裁定保留。\n`);
const excluded=new Set(['.git','node_modules','runtime','codex-home','codex-home-fake','member-codex-home','sessions','cache']);
const copies=[];
async function collect(dir,rel=''){for(const e of await fs.readdir(path.join(dir,rel),{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Unexpected evidence link');const p=path.join(rel,e.name);if(e.isDirectory()){if(!excluded.has(e.name))await collect(dir,p);}else if(!['auth.json','config.toml'].includes(e.name)&&!e.name.endsWith('.sqlite')){const b=await fs.readFile(path.join(dir,p));if(b.includes(0))throw Error('Unexpected binary evidence');if(/pcp_(?:cli_auth_|agent_)?[a-zA-Z0-9_-]{28,}|\bsk-[a-zA-Z0-9_-]{30,}/.test(b.toString('utf8')))throw Error('Potential secret in evidence: '+p);copies.push({path:path.join(relative,p),bytes:b});}}}
await collect(evidence);
for(const f of copies){const dest=path.join(target,f.path);const old=await fs.readFile(dest).catch(()=>null);if(old&&!old.equals(f.bytes)){const save=path.join(backup,'overwritten-final-evidence',f.path);await fs.mkdir(path.dirname(save),{recursive:true});await fs.writeFile(save,old);}await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,f.bytes);}
const manifest=JSON.parse(await fs.readFile(path.join(backup,'sync-manifest.json'),'utf8'));
for(const f of manifest){const d=await fs.readFile(path.join(target,f.path)),e=await fs.readFile(path.join(root,f.path));if(!d.equals(e))throw Error('Source mismatch: '+f.path);}
const runtimeBefore=JSON.parse(await fs.readFile(path.join(backup,'verification/runtime-before.json'),'utf8'));
for(const f of runtimeBefore){const p=path.join(target,'member-agent/runtime',f.path),s=await fs.stat(p);if(createHash('sha256').update(await fs.readFile(p)).digest('hex')!==f.sha256||s.mtimeMs!==f.mtimeMs)throw Error('Runtime changed: '+f.path);}
const status=spawnSync('git',['status','--porcelain'],{cwd:target,encoding:'utf8',windowsHide:true});if(status.status!==0)throw Error('git status failed');
await fs.writeFile(path.join(backup,'git-status-final.txt'),status.stdout);
const summary={localMemberTests:216,localServerTests:240,memberTypeErrors:0,serverTypeErrors:0,sourceFilesEqual:9,protectedRuntimeFilesUnchanged:16,evidenceFilesCopied:copies.length,deployed:true,health:deployed.health,memberNoKeyHttpStatus:401,dbUnchanged:true,realS7Retest:'owner to perform'};
await fs.writeFile(path.join(backup,'final-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
