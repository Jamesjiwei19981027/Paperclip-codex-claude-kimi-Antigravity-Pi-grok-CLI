// Real Windows PowerShell 5.1 JSON body, local HTTP receiver only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

const expected = { title: "中文标题与任务完成评论" };
const received = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  received.push({ contentType: req.headers["content-type"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
  res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
try {
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Write-Output ('PowerShell='+$PSVersionTable.PSVersion.ToString()); $json='${JSON.stringify(expected)}'; Invoke-RestMethod -Method Patch -Uri 'http://127.0.0.1:${server.address().port}/api/issues/fixture' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' | Out-Null`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  let output = ""; child.stdout.on("data", bytes => output += bytes); child.stderr.on("data", bytes => output += bytes);
  const timer = setTimeout(() => child.kill(), 15_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); clearTimeout(timer);
  console.log(output.trim()); console.log(`exitCode=${code}`); console.log(`received=${JSON.stringify(received)}`);
  assert.equal(code, 0); assert.deepEqual(received, [{ contentType: "application/json; charset=utf-8", body: expected }]);
  console.log("UTF-8 字节请求保留中文：通过");
} finally { await new Promise(resolve => server.close(resolve)); }
