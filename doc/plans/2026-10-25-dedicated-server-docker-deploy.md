# 专用服务器 Docker 部署清单（192.168.0.213）

日期：2026-10-25  
目的：在专用服务器上以 `authenticated` 模式运行当前工作区代码，验证成员智能体服务器端。  
范围：只部署服务器，不含成员端代理（尚未开发）。  
状态：未执行。命令由负责人在服务器上运行，输出贴回核对。

## 已确认的服务器环境（2026-10-25 负责人提供）

Ubuntu 24.04.3，x86_64，16 核，内存 17 GiB（可用约 12 GiB），根分区剩余 49 GB，Docker 29.7.2，Compose 5.4.0，3100/5432/7000 端口空闲。服务器主机上的 Node 22 与 pnpm 10 不使用，全部在容器内构建。

## 安全前提

- 负责人曾把 root 密码贴进对话，部署完成后**必须更换**，并改为密钥登录、禁止 root 密码登录；
- 所有密钥（数据库密码、`BETTER_AUTH_SECRET`、工具签名密钥）在服务器上用 `openssl` 生成，写入 `.env`（权限 600），**不要贴回对话**；
- 数据库端口**不对宿主机开放**（仓库示例的 compose 会发布 5432 且密码为 paperclip，本清单不采用）。

## 步骤

### 1. 传源码包（在 Windows 的 PowerShell 里执行，输入服务器密码）

源码包：`E:\AI_Data\tools\paperclip-deploy\paperclip-src-20261025.tar.gz`，28,103,701 字节，SHA-256 `31058d8ac4528e3814683b28a448d42884634dcf4913ddee604e44c6994ca7c8`，9,416 个文件。已排除公司初始化脚本、`.git`、依赖目录、本机运行目录、日志与截图；包含成员智能体全部修改。

```powershell
scp E:\AI_Data\tools\paperclip-deploy\paperclip-src-20261025.tar.gz root@192.168.0.213:/root/
```

### 2. 解包（在服务器上）

不要使用 `/root/paperclip`（里面已有内容，先 `ls /root/paperclip` 看一眼是什么）。用新目录：

```bash
sha256sum /root/paperclip-src-20261025.tar.gz
mkdir -p /root/paperclip-deploy/src && tar -xzf /root/paperclip-src-20261025.tar.gz -C /root/paperclip-deploy/src
ls /root/paperclip-deploy/src | head
```

校验码必须与上面一致。

### 3. 生成密钥与环境文件

```bash
cd /root/paperclip-deploy
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
PAPERCLIP_PUBLIC_URL=http://192.168.0.213:3100
EOF
chmod 600 .env
```

### 4. 写 compose 文件

```bash
cd /root/paperclip-deploy
cat > docker-compose.yml <<'EOF'
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: paperclip
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
      POSTGRES_DB: paperclip
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paperclip -d paperclip"]
      interval: 2s
      timeout: 5s
      retries: 30
    volumes:
      - pgdata:/var/lib/postgresql/data

  server:
    build:
      context: ./src
      dockerfile: Dockerfile
    restart: unless-stopped
    pids_limit: 2048
    ports:
      - "3100:3100"
    environment:
      DATABASE_URL: postgres://paperclip:${POSTGRES_PASSWORD:?}@db:5432/paperclip
      PORT: "3100"
      HOST: "0.0.0.0"
      SERVE_UI: "true"
      PAPERCLIP_HOME: /paperclip
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: ${PAPERCLIP_PUBLIC_URL:?}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?}
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: ${PAPERCLIP_TOOL_ACTION_SIGNING_SECRET:?}
      PAPERCLIP_AGENT_JWT_TTL_SECONDS: "172800"
    volumes:
      - paperclip-data:/paperclip
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
  paperclip-data:
EOF
docker compose config > /dev/null && echo "配置语法正确"
```

`PAPERCLIP_AGENT_JWT_TTL_SECONDS=172800`（48 小时）是显式写出默认值；成员服务启动时会检查它不低于 8 小时（`assertMemberAgentJwtTtl`）。

### 5. 构建并启动

首次构建较慢（下载依赖、编译），可能十几分钟；如果卡在下载依赖或报网络错误，把最后 30 行贴回，需要配置镜像源。

```bash
cd /root/paperclip-deploy
docker compose build 2>&1 | tail -n 40
docker compose up -d
docker compose ps
```

### 6. 验收（逐项）

```bash
# a. 健康检查：应为 status ok，deploymentMode 为 authenticated
curl -s http://localhost:3100/api/health | head -c 600; echo

# b. 成员连接入口应已启用：日志里不应出现 "member_agent WebSocket disabled"
docker compose logs server 2>&1 | grep -i member_agent || echo "无 member_agent 日志（正常）"

# c. 无 Key 连接成员入口应被拒绝（预期 401）
curl -s -i -m 5 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" http://localhost:3100/api/member-agent/v1/connect | head -3

# d. 数据库端口不应对外开放
ss -ltnp | grep ':5432' || echo "5432 未对外开放（正确）"

# e. 令牌有效期检查：容器环境里应为 172800
docker compose exec server printenv PAPERCLIP_AGENT_JWT_TTL_SECONDS
```

通过标准：a 显示 `authenticated`；b 没有"disabled"；c 返回 401；d 未开放；e 为 172800。

### 7. 首次登录

浏览器打开 `http://192.168.0.213:3100`，注册账号后选择 `Claim this instance` 成为首位管理员（authenticated/private 模式支持浏览器认领）。

## 回滚与清理

- 停止：`docker compose down`（保留数据卷）；
- 彻底清除（会删数据库和数据）：`docker compose down -v`，仅在确认不需要数据时使用；
- 代码更新：重新传包解压覆盖 `src/` 后 `docker compose build && docker compose up -d`。

## 本清单验证不到的内容

- 没有任何成员代理能连上（阶段 2 才开发）；
- 公网明文被拒绝需要从外网测试，局域网内无法验证（局域网明文本来允许）；
- frp 与 `wss://` 见实现规格第 16 节，等服务器接入 frp 时再验证；
- 容器内 Codex 等命令行工具的登录与额度，不在本清单范围。
