import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root='E:/workspace/paperclip-member-agent-dev',target='D:/paperclip';
const rel='doc/plans/2026-10-27-member-agent-s7-final-evidence';
const evidence=path.join(root,rel),backup='E:/AI_Data/backups/paperclip/2026-10-27-before-s7-fix';
for(const name of ['member-tests','server-tests','member-tsc','server-tsc']){const s=await fs.readFile(path.join(backup,'verification',name+'.log'),'utf8');if(!s.includes('EXIT_CODE=0'))throw Error('Verification incomplete: '+name);}
const report=`# S7 收尾与同步记录\n\n阶段：3 / S7 修复收尾。日期：2026-10-27。部署结果另行追加。\n\n## 改动文件\n\n合并补丁包含原 S7 七个文件，加 server/src/services/agent-configuration.ts 和 server/src/__tests__/member-agent-concurrency.test.ts，共九个文件。路径和 SHA-256 见备份目录 sync-manifest.json。创建入口忽略 member_agent 显式并发数；统一配置写入钩子在修改与回滚时纠正为 1，保留其他字段。其他适配器不变，不执行数据迁移。\n\n## 命令与完整输出\n\nE 盘：forced-red.log 保留改动前失败，forced-green.log 为八文件 240 项通过；server-tsc.log 退出 0。新增用例包括创建传 20 得 1、修改传 5 得 1、title/adapterConfig 修改纠正既有 20、process/codex_local 保留 20、切换适配器时纠正。\n\nD 盘输出全部位于 E:/AI_Data/backups/paperclip/2026-10-27-before-s7-fix/verification/：member-tests.log 为 209 项通过；build-tests.log 为隔离副本七项通过，合计 216 项。server-tests.log 为八文件 240 项通过。member-tsc.log / server-tsc.log 均退出 0，无新增错误。命令参数保存在相应 command.json。\n\n## 验收项逐条结论\n\n- 强制单并发、保留其他字段和适配器行为：通过。\n- 补丁在 D 当前源码临时快照及 D 工作区 git apply --check：通过；应用后九文件 E/D SHA-256 一致。\n- D 本机 3100 无监听；没有启动本机服务。\n- 正在使用的 runtime 十六文件内容与修改时间未变；七项构建测试仅写临时副本，联接先删除，临时目录安全清理。\n- 源码备份和哈希、git status 前后、完整测试输出已保存。\n- 服务器部署：待执行。负责人 2026-10-27 11:57 北京时间确认 BoSi 无 running/queued/scheduled_retry，实时运行列表为空，测试成员 idle/ready。超过 12:27 不切换应用，等待负责人复核。\n\n## 偏离本规格的地方\n\n无。未修改共享恢复提示。\n\n## 遇到但未解决的问题\n\n共享恢复提示仍含原生工具名，按负责人裁定保留为已知问题；既有成员配置不迁移，未来配置修改时才纠正。短暂失败重试沿用既有上限。\n\n## 下一阶段需要负责人确认的事项\n\n部署后由负责人复验 S7；本轮不修改测试智能体配置、不派发或取消任务。\n`;
await fs.writeFile(path.join(evidence,'report.md'),report);
await fs.copyFile(path.join(backup,'verification','server-tests.log'),path.join(evidence,'d-server-tests.log'));
const excludedDirs=new Set(['.git','node_modules','runtime','codex-home','codex-home-fake','member-codex-home','sessions','cache']);
const excludedFiles=new Set(['auth.json','config.toml']);
const files=[];
async function collect(base,relative=''){for(const e of await fs.readdir(path.join(base,relative),{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Unexpected evidence link');if(e.isDirectory()){if(!excludedDirs.has(e.name))await collect(base,path.join(relative,e.name));}else if(!excludedFiles.has(e.name)&&!e.name.endsWith('.sqlite'))files.push({base,relative:path.join(relative,e.name)});}}
for(const r of ['doc/plans/2026-10-27-member-agent-s7-evidence',rel])await collect(path.join(root,r));
const suspicious=[];
for(const f of files){const b=await fs.readFile(path.join(f.base,f.relative));if(b.includes(0))throw Error('Unclassified binary evidence: '+f.relative);const text=b.toString('utf8');if(/pcp_(?:cli_auth_|agent_)?[a-zA-Z0-9_-]{28,}|\bsk-[a-zA-Z0-9_-]{30,}/.test(text))suspicious.push(f.relative);}
if(suspicious.length)throw Error('Potential sensitive evidence (not copied): '+suspicious.join(', '));
const copied=[];
for(const f of files){const relative=path.relative(root,path.join(f.base,f.relative)),dest=path.join(target,relative);const prior=await fs.stat(dest).then(()=>true,()=>false);if(prior){const old=await fs.readFile(dest),next=await fs.readFile(path.join(root,relative));if(!old.equals(next)){const save=path.join(backup,'overwritten-evidence',relative);await fs.mkdir(path.dirname(save),{recursive:true});await fs.writeFile(save,old);}}await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,relative),dest);copied.push({path:relative,sha256:createHash('sha256').update(await fs.readFile(dest)).digest('hex')});}
await fs.writeFile(path.join(backup,'evidence-sync.json'),JSON.stringify(copied,null,2));
const result=spawnSync('git',['status','--porcelain'],{cwd:target,encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('git status failed');await fs.writeFile(path.join(backup,'git-status-after.txt'),result.stdout);
const before=await fs.readFile(path.join(backup,'git-status-before.txt'),'utf8');const beforeLines=new Set(before.trim().split(/\r?\n/)),afterLines=new Set(result.stdout.trim().split(/\r?\n/));
await fs.writeFile(path.join(backup,'git-status-comparison.json'),JSON.stringify({added:[...afterLines].filter(x=>!beforeLines.has(x)),removed:[...beforeLines].filter(x=>!afterLines.has(x))},null,2));
console.log(JSON.stringify({localVerification:'passed',sanitizedEvidenceFilesCopied:copied.length,backup}));
