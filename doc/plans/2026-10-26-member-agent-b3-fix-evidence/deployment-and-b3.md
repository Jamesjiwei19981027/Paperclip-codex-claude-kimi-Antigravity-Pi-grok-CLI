# B3 独立补丁部署与真实复验记录

日期：2026-10-26。状态：已部署候选应用镜像并完成 B3 真实取消验收。本机 D 盘源码未修改。

> 本文下方的“复核结论”“部署对象与检查点”“重启电脑后的成员端准备”是部署前准备方案，其中“尚未连接或部署”等语句记录的是当时状态；实际执行结果以文末“部署与 B3 验收结果”为准。

## 复核结论

补丁只修改 member_agent 服务端适配器，新增对应的隔离测试。确认边界为已有服务器取消请求 + 当前公司/智能体连接 + 当前 jobId 的严格结果 + 成员 JobRunner 完成 worker/登记进程树清理后的 cancelled 结果。成员提交的 `resultJson.executionCancellation` 先剥离，再由服务器生成确认。断线、超时未确认、成功结果与取消竞争、清理失败不会冒充停止确认。

执行只读核对、备份、应用补丁、构建、切换应用容器及真实测试前，仍须负责人解除此前“不连接专用服务器、不部署、不重启服务”的限制。批准也不包括修改 D:\paperclip、停止桌面版 Codex 或接触真实 Codex 登录凭据。

## 部署对象与检查点

- 目标：`192.168.0.213` 的 Paperclip 应用容器，已存部署文档记载 Compose 目录为 `/root/paperclip-deploy`、源码为其 `src/`。这些是历史记录，连接后先只读确认，不假定仍相同。
- 本机补丁：`E:\workspace\paperclip-member-agent-dev\doc\plans\2026-10-26-member-agent-b3-fix-evidence\b3-stop-confirmation.patch`。
- 补丁 SHA-256：`725C01C3F773FA57BD5E84598EC05846C5D3401976E599E5841244CCC0BB680F`。
- 补丁应用前 execute.ts 的 SHA-256：`dd155718d00d5b1a7426c8955c0d063400ca0be045bd812c07d69529839ada53`。远端文件不匹配则停止，先核对差异，不强行套补丁。
- 仅切换 `server` 服务；不停止或重建 `db`，不删卷，不覆盖 `.env`、数据库或实例数据。不输出 Compose 展开配置或容器全量环境。
- 审批后先读取当前应用镜像 ID、健康状态和是否有活动运行；存在活动任务则先回报，避免中途切换。保留当前镜像标签与两份补丁涉及文件的备份，以便回退。
- 在服务器独立临时源码副本执行 `git apply --check`、应用补丁及校验改动范围，构建候选镜像。构建失败时保留原应用容器运行，不重启来试错。
- 切换时仅替换应用镜像，记录新 processStartedAt、health、authenticated 模式和 WebSocket 连接状态。健康失败则按备份镜像回滚应用，不操作数据库卷。

远端登录由负责人在正常 SSH 登录流程完成，不索取或保存密码，不从历史对话恢复密码，不读取密钥或浏览器 cookie。

## 重启电脑后的成员端准备

此前代理和两个假模型进程已随电脑重启结束。需要在成员 Windows 电脑重新启动延迟假模型，不能沿用旧的 38842 端口。

```powershell
Set-Location -LiteralPath 'E:\workspace\paperclip-member-agent-dev'
node .\member-agent\test\fixtures\fake-model-server.mjs 0 600000
```

保持窗口打开，记录打印的新回环 URL。只更新独立 `codex-home-fake/config.toml` 的假模型 base_url；不要覆盖真实账号的 home。成员 Key 只通过安全输入存入当前环境变量，不能重新使用电脑重启前 PowerShell 的变量，也不要打印它或配置全文。

```powershell
$memberSecret = Read-Host '输入成员测试智能体 Key（不回显）' -AsSecureString
$memberBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($memberSecret)
try { $env:PAPERCLIP_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($memberBstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($memberBstr); $memberSecret.Dispose() }
$memberConfigPath = Join-Path $env:APPDATA 'paperclip-member-agent\config.json'
node .\member-agent\src\main.ts run --config $memberConfigPath
```

Key 失效时由负责人在服务器看板创建同一智能体的替代 Key；不要把 Key 发到对话。

## 部署与 B3 验收结果

- 候选应用镜像已部署到 `192.168.0.213` 的 Paperclip 应用服务。只切换应用容器，数据库容器和数据卷未重建。健康检查返回 HTTP 200，`status=ok`，`deploymentMode=authenticated`，`authReady=true`；镜像摘要记录在 `deployed-health.json`。本次 `/api/health` 响应不提供 `processStartedAt`，不据此报告服务器进程启动时间。
- 测试代理用独立 fake Codex home 和回环假模型运行；假模型声明 `requires_openai_auth=false`，没有使用真实 Codex 账号或 `auth.json`。代理日志确认连接，服务器报告固定版本 `0.160.0`。成员 API Key 没有写入证据文件。
- 在测试工单 `BOS-8` 上产生一次运行：run `ec139891-435a-4e2e-8124-4a882810df5a`。取消前捕获到固定路径的 Codex `0.160.0` 进程 PID `10776`，创建时间 `2026-10-26T20:18:54.4689+08:00`；同一快照记录代理 PID `15300`。取消请求时间为 `2026-10-26T12:20:37.411Z`，服务器确认时间为 `2026-10-26T12:20:57.906Z`，相差 20.495 秒。
- 取消响应和独立运行读回均为 `status=cancelled`、`errorCode=cancelled`；`resultJson.executionCancellation` 的状态为 `acknowledged`，proof 为 `member_agent_stop_result`，run、agent、company ID 与本次运行一致。
- 确认停止后 103.3 秒，PID `10776` 连同原创建时间已不存在，固定版 Codex 根进程列表为空。后续本机核对未发现成员代理 Node 进程、固定版 Codex 进程或回环假模型端口 `57493` 的监听。截图/命令中的 PID `29652` 是 Clash Verge 的 `verge-mihomo.exe`，不是本次测试代理或假模型进程。
- 测试工单 `BOS-8` 已关闭为 cancelled；测试智能体已恢复到原先的 paused 状态。原历史工单 `BOS-7` 未修改。本机代理与假模型均已停止，没有活动测试运行。
- 临时 Board CLI 登录已撤销，本机对应凭据已删除。新创建的成员测试 Key 仍有效；如不再用于后续验收，可由负责人在 API Keys 页面撤销。

证据文件位于 `b3-a521a7be/`：`before-cancel.json`、`cancel-response.json`、`after-cancel-processes.json`、`post-cleanup-check.json`、`config.json`、`setup.json` 和 `run-member-agent-b3.ps1`。其中配置和脚本不包含成员 Key。部署前后检查分别见 `deployment-readiness.json`、`deployed-health.json` 与 `health-comparison.json`。

### 验收边界

这次真实验收覆盖了服务器取消请求、当前 agent/job 的停止确认和固定版 Codex 根进程退出。假模型没有启动 shell 子进程，因此本次没有真实验证 Codex 的孙进程；Windows 假子孙进程测试是补充自动化证据，完整真实 Codex 进程树仍应按 S4 验收。

## B3 判定与证据

只用新建的测试工单、一次新运行，保留 BOS-7 历史失败。派发后确认进程来自 `E:\AI_Data\tools\codex-0.160.0\codex.exe`。不能按进程名终止所有 codex.exe；桌面版 Codex 的 app-server/exec-server 不属于本测试。

取消前保存该测试 Codex 及其子孙进程的 PID、父 PID、创建时间和可执行路径。取消后必须逐个核对此前的 PID+创建时间，防止父进程消失后仅从现存根进程递归查找漏掉孤儿进程。

通过要求：

1. 看板/接口取消本次运行，不再得到“无法确认 provider 停止”的 409。
2. 独立 GET 本次运行，状态为 cancelled，`resultJson.executionCancellation.state` 为 acknowledged，proof 为 member_agent_stop_result，runId/agentId/companyId 与本次一致。
3. 在 graceSec + 10 秒窗口内，本次固定版本 Codex 以及取消前捕获的所有子孙进程均退出（按同一机器时间计时）。
4. 关闭这份专用测试工单以避免假模型触发自动续跑；再读取运行列表确认没有新的测试进程/非预期续跑。此步骤不改原 BOS-7 的历史停止证据。
5. 导出本次运行编号、取消响应、运行状态与停止确认、前后进程快照和日志脱敏扫描结果。成员 Key 没有读取权限时，由负责人看板/浏览器登录会话完成读回，不越权使用数据库。

延迟假模型通常不会启动 shell，因此真实 B3 可能只见 Codex 本体。已完成的 Windows 子孙进程自动化测试可作为补充证据；不能声称本次真实 B3 覆盖了并未出现的孙进程。真实账号完整进程树验证仍属于 S4。
