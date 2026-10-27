import { execFile, fork } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, validateConfig } from "../src/config.ts";
import { assertTransportAllowed } from "../src/transport-check.ts";
import { Logger, Redactor } from "../src/logger.ts";
import { acquireLock, LockError } from "../src/lock.ts";
import { terminateProcessTree } from "../src/process-tree.ts";

const validConfig = () => ({
  serverUrl: "http://192.168.0.213:3100", agentKey: "FAKE-agent-key-only-for-tests",
  executor: "echo", projectDirs: {}, defaultCwd: "",
});
const testDir = () => mkdtemp(path.join(tmpdir(), "paperclip-member-foundation-test-"));

describe("#1 配置校验", () => {
  it("缺字段、类型、未知字段的多个错误一次列全且不输出字段值", () => {
    const invalid = { serverUrl: "ftp://example.com/path", agentKey: 123, executor: "codex", projectDirs: [], defaultCwd: false, typo: "FAKE-DO-NOT-PRINT" };
    let failure: ConfigError | undefined;
    try { validateConfig(invalid, {}); } catch (error) { failure = error as ConfigError; }
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure?.messages).toHaveLength(6);
    for (const field of ["serverUrl", "agentKey", "executor", "projectDirs", "defaultCwd", "typo"]) expect(failure?.message).toContain(field);
    expect(failure?.message).not.toContain("FAKE-DO-NOT-PRINT");
    try { validateConfig({}, {}); } catch (error) { expect((error as ConfigError).messages).toHaveLength(5); return; }
    throw new Error("missing fields must fail");
  });
  it("环境 Key 优先并允许配置不含 Key；空环境 Key 仍须报错", () => {
    const input: Record<string, unknown> = validConfig(); delete input.agentKey;
    expect(validateConfig(input, { PAPERCLIP_AGENT_KEY: "FAKE-env-key-only-for-tests" }).agentKey).toBe("FAKE-env-key-only-for-tests");
    expect(validateConfig(validConfig(), { PAPERCLIP_AGENT_KEY: "FAKE-env-wins" }).agentKey).toBe("FAKE-env-wins");
    expect(() => validateConfig(validConfig(), { PAPERCLIP_AGENT_KEY: "" })).toThrow(ConfigError);
  });
  it("配置诊断中与 Key 相同的字段名也脱敏", () => {
    try { validateConfig({ ...validConfig(), agentKey: "executor", executor: "codex" }, {}); }
    catch (error) { expect((error as Error).message).not.toContain("executor"); return; }
    throw new Error("invalid executor must fail");
  });
  it.each(["192.168.0.213:3100", "http://host/path", "http://host/path/..", "http://host/.", "http://host?key=x", "http://host/#x", "http://user:pass@host", "ws://host", "http://host/?", "http://host/#", " http://host", "http://host\\path"])("拒绝非纯 HTTP(S) 源地址 %s", (serverUrl) => {
    expect(() => validateConfig({ ...validConfig(), serverUrl }, {})).toThrow(ConfigError);
  });
  it("读取 UTF-8 JSON；拒绝 BOM 和非法 JSON，错误不回显内容", async () => {
    const dir = await testDir(); const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(validConfig()), "utf8");
    const warnings: string[] = [];
    expect((await loadConfig(configPath, {}, (message) => warnings.push(message))).executor).toBe("echo");
    expect(warnings.join("")).not.toContain(validConfig().agentKey);
    if (process.platform === "win32") expect(warnings.join("")).toContain("icacls");
    await writeFile(configPath, '\uFEFF' + JSON.stringify(validConfig()), "utf8");
    await expect(loadConfig(configPath, {})).rejects.toThrow(ConfigError);
    await writeFile(configPath, '{"agentKey":"FAKE-INVALID-JSON-SECRET",', "utf8");
    await expect(loadConfig(configPath, {})).rejects.not.toThrow("FAKE-INVALID-JSON-SECRET");
  });
  it.skipIf(process.platform !== "win32")("缺少 USERDOMAIN 且配置路径含中文空格时正确判断 ACL", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "成员 路径-")); const configPath = path.join(dir, "配置 文件.json");
    await writeFile(configPath, JSON.stringify(validConfig()));
    const execFileAsync = promisify(execFile);
    const identity = await execFileAsync("whoami.exe", [], { windowsHide: true, encoding: "utf8" });
    const account = identity.stdout.trim(); expect(account).not.toBe("");
    await execFileAsync("icacls.exe", [configPath, "/inheritance:r", "/grant:r", `${account}:(R)`], { windowsHide: true });
    const oldDomain = process.env.USERDOMAIN;
    try {
      delete process.env.USERDOMAIN;
      const warnings: string[] = [];
      await loadConfig(configPath, {}, message => warnings.push(message));
      expect(warnings).toHaveLength(0);
      await execFileAsync("icacls.exe", [configPath, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
      await loadConfig(configPath, {}, message => warnings.push(message));
      expect(warnings).toHaveLength(1);
    } finally {
      if (oldDomain === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = oldDomain;
    }
  });
  it.skipIf(process.platform !== "win32")("权限检查程序失败时仅警告一次，不阻止读取配置或泄露内容", async () => {
    const dir = await testDir(); const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(validConfig()));
    const execFileAsync = promisify(execFile);
    const account = (await execFileAsync("whoami.exe", [], { windowsHide: true })).stdout.trim();
    await execFileAsync("icacls.exe", [configPath, "/inheritance:r", "/grant:r", `${account}:(R)`], { windowsHide: true });
    const original = process.env.SystemRoot;
    try {
      process.env.SystemRoot = path.join(dir, "不存在的系统目录");
      const warnings: string[] = [];
      const config = await loadConfig(configPath, {}, message => warnings.push(message));
      expect(config.executor).toBe("echo");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("无法确认权限");
      expect(warnings[0]).not.toContain(validConfig().agentKey);
      expect(warnings[0]).not.toContain(validConfig().serverUrl);
    } finally {
      if (original === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = original;
    }
  });
  it.skipIf(process.platform !== "win32")("真实 Windows ACL：仅当前用户可读不警告，Everyone 可读时警告且给出命令", async () => {
    const dir = await testDir(); const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(validConfig()));
    const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
    const execFileAsync = promisify(execFile); const warnings: string[] = [];
    await execFileAsync("icacls.exe", [configPath, "/inheritance:r", "/grant:r", `${account}:(R)`], { windowsHide: true });
    await loadConfig(configPath, {}, (message) => warnings.push(message));
    if (warnings.length) {
      // Independent diagnostic after the warning; never print configuration contents.
      const capture = async (command: string, args: string[]) => {
        try {
          const result = await execFileAsync(command, args, { windowsHide: true, encoding: "buffer", timeout: 5000 });
          return { exit: 0, stdoutHex: result.stdout.toString("hex"), stdoutUtf8: result.stdout.toString("utf8"), stderrHex: result.stderr.toString("hex"), stderrUtf8: result.stderr.toString("utf8") };
        } catch (error) {
          const e = error as { code?: unknown; killed?: boolean; signal?: unknown; stdout?: Buffer; stderr?: Buffer };
          return { exit: e.code, killed: e.killed, signal: e.signal, stdoutHex: e.stdout?.toString("hex"), stdoutUtf8: e.stdout?.toString("utf8"), stderrHex: e.stderr?.toString("hex"), stderrUtf8: e.stderr?.toString("utf8") };
        }
      };
      console.error("ACL_DIAGNOSTIC", JSON.stringify({ userDomainPresent: Boolean(process.env.USERDOMAIN), username: userInfo().username, account, warnings, icacls: await capture("icacls.exe", [configPath]), codepage: await capture("cmd.exe", ["/d", "/c", "chcp"]) }));
    }
    expect(warnings).toHaveLength(0);
    await execFileAsync("icacls.exe", [configPath, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
    await loadConfig(configPath, {}, (message) => warnings.push(message));
    expect(warnings).toHaveLength(1); expect(warnings[0]).toContain("icacls"); expect(warnings[0]).not.toContain(validConfig().agentKey);
  });
});

describe("#2 明文传输自检", () => {
  it.each(["127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "100.64.0.1", "100.127.255.254", "169.254.1.1", "localhost", "MEMBER-PC", "[::1]", "[fd12::1]", "[fe80::1]", "[::ffff:192.168.1.1]"])("允许服务器规则中的内网主机 %s", (host) => {
    expect(() => assertTransportAllowed(`http://${host}:3101`)).not.toThrow();
  });
  it.each(["8.8.8.8", "172.32.0.1", "100.63.255.255", "100.128.0.0", "example.com", "localhost.example.com", "localhost.", "[2001:4860:4860::8888]", "[::ffff:8.8.8.8]"])("拒绝明文公网或有点号的主机 %s", (host) => {
    expect(() => assertTransportAllowed(`http://${host}`)).toThrow("明文只允许用于内网，请改用 https://");
  });
  it("允许任意有效 HTTPS 源地址但拒绝其他协议", () => {
    expect(() => assertTransportAllowed("https://example.com")).not.toThrow();
    expect(() => assertTransportAllowed("https://8.8.8.8")).not.toThrow();
    expect(() => assertTransportAllowed("ws://localhost")).toThrow();
  });
});

describe("#14 同一脱敏器保护控制台和日志", () => {
  const secret = 'FAKE-key-"quoted"/中文?+%secret';
  it("文本、JSON 键和值、URL 编码均脱敏", () => {
    const redactor = new Redactor(); redactor.register(secret, undefined, "FAKE-run-token", "FAKE-tool-token");
    const input = `${secret} ${JSON.stringify({ [secret]: secret })} https://example.com/?token=${encodeURIComponent(secret)} FAKE-run-token FAKE-tool-token`;
    const output = redactor.redact(input);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(output).not.toContain(encodeURIComponent(secret));
    expect(output).not.toContain("FAKE-run-token"); expect(output).not.toContain("FAKE-tool-token");
    expect(output).toContain("FAKE…");
  });
  it("每个流保留可能匹配的尾部，跨任意边界拆分均无泄露", () => {
    const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
    for (const variant of variants) {
      for (let split = 1; split < variant.length; split++) {
        const redactor = new Redactor(); redactor.register(secret);
        const first = redactor.chunk("stdout", `开始 ${variant.slice(0, split)}`);
        expect(first).toBe("开始 ");
        expect(redactor.chunk("stderr", "另一个流\n")).toBe("另一个流\n");
        const output = first + redactor.chunk("stdout", `${variant.slice(split)} 完成`) + redactor.finish("stdout");
        expect(output).toBe("开始 FAKE… 完成");
      }
    }
  });
  it("结束不泄露未确认的令牌前缀；短密钥不完整显示", () => {
    const redactor = new Redactor(); redactor.register("FAKE-partial-secret", "xy");
    const output = redactor.chunk("stream", "内容 FAKE-par") + redactor.finish("stream");
    expect(output).not.toContain("FAKE-par"); expect(output).toContain("…");
    expect(redactor.redact("xy")).not.toBe("xy");
  });
  it("日志一行一条并在文件及控制台脱敏，清理七天前日志而保留其他文件", async () => {
    const dir = await testDir();
    await writeFile(path.join(dir, "agent-20000101.log"), "old test log");
    await writeFile(path.join(dir, "keep.txt"), "keep");
    const consoleText: string[] = []; const logger = new Logger(dir, [secret], (text) => consoleText.push(text));
    logger.write("info", `消息 ${secret}\n第二行`, true);
    logger.write("debug", "仅文件", false);
    logger.redactor.register("FAKE-runtime-later"); logger.write("error", "FAKE-runtime-later", true);
    const names = await readdir(dir); expect(names).not.toContain("agent-20000101.log"); expect(names).toContain("keep.txt");
    const logFile = names.find((name) => /^agent-\d{8}\.log$/.test(name))!;
    const fileText = await readFile(path.join(dir, logFile), "utf8");
    expect(fileText).not.toContain(secret); expect(consoleText.join("")).not.toContain(secret);
    expect(fileText).not.toContain("FAKE-runtime-later"); expect(consoleText.join("")).not.toContain("FAKE-runtime-later");
    expect(fileText).toContain("仅文件"); expect(consoleText.join("")).not.toContain("仅文件");
    expect(fileText.trim().split("\n")).toHaveLength(3);
  });
  it("Logger.write 连续消息拆开的密钥不会进入文件或控制台", async () => {
    const dir = await testDir(); const output: string[] = [];
    const logger = new Logger(dir, [secret], (message) => output.push(message));
    logger.write("info", `开始 ${secret.slice(0, 12)}`, true);
    logger.write("info", `${secret.slice(12)} 完成`, true);
    const names = await readdir(dir); const fileText = await readFile(path.join(dir, names[0]!), "utf8");
    expect(fileText).not.toContain(secret.slice(0, 12)); expect(fileText).not.toContain(secret.slice(12));
    expect(output.join("")).not.toContain(secret.slice(0, 12)); expect(output.join("")).not.toContain(secret.slice(12));
  });
});

describe("#16 单实例锁", () => {
  it("活进程锁拒绝且退出码 5；释放后可以重新获取", async () => {
    const dir = await testDir(); const release = await acquireLock(dir);
    try {
      await expect(acquireLock(dir)).rejects.toMatchObject({ code: 5 });
      expect(await readFile(path.join(dir, "agent.lock"), "utf8")).toBe(String(process.pid));
    } finally { await release(); }
    const releaseAgain = await acquireLock(dir); await releaseAgain();
  });
  it("陈旧锁被覆盖；并发申请只允许一个成功", async () => {
    const dir = await testDir(); await writeFile(path.join(dir, "agent.lock"), "2147483647");
    const attempts = await Promise.allSettled([acquireLock(dir), acquireLock(dir)]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const failed = attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(LockError);
    for (const attempt of attempts) if (attempt.status === "fulfilled") await attempt.value();
  });
  it("崩溃留下的陈旧获取锁也可恢复，活进程获取锁不会被删除", async () => {
    const dir = await testDir(); const guard = path.join(dir, "agent.lock.recovery");
    await writeFile(guard, "2147483647");
    const release = await acquireLock(dir); await release();
    await writeFile(guard, String(process.pid));
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(LockError);
    expect(await readFile(guard, "utf8")).toBe(String(process.pid));
  });
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

describe("#15 进程树终止", () => {
  it("无效或自身 PID 不会调用终止工具", async () => {
    for (const pid of [0, -1, 1.5, process.pid, NaN]) await expect(terminateProcessTree(pid)).rejects.toThrow();
  });
  it.skipIf(process.platform !== "win32")("taskkill 确实终止测试子进程及孙进程", async () => {
    const child = fork(fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let grandchildPid: number | undefined;
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("测试进程未就绪")), 10_000);
        child.once("message", (message) => { clearTimeout(timeout); resolve((message as { grandchildPid: number }).grandchildPid); });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      });
      expect(processExists(child.pid!)).toBe(true); expect(processExists(grandchildPid)).toBe(true);
      await terminateProcessTree(child.pid!);
      expect(processExists(child.pid!)).toBe(false); expect(processExists(grandchildPid)).toBe(false);
    } finally {
      // Cleanup must survive a failing implementation under test.
      const execFileAsync = promisify(execFile);
      for (const pid of [child.pid, grandchildPid]) {
        if (pid && processExists(pid)) await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      }
    }
  }, 20_000);
});
