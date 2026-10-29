import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const installer = path.resolve(import.meta.dirname, "../installer/install.ps1");
it("preserves the original Codex missing-auth prompt and login call", async () => {
  const source = await readFile(installer, "utf8");
  expect(source).toContain("if (!$TestMode -and !(Test-Path -LiteralPath (Join-Path $ConfigDir 'codex-home\\auth.json')) -and (Confirm-Member '现在登录 Codex 吗？' $false))");
  expect(source).toContain("$loginCode = Invoke-MemberCommand $versionPath 'login'");
});
for (const shell of ["powershell.exe", "pwsh.exe"]) {
  it.each([
    ["codex", false, true], ["codex", false, false], ["codex", true, true],
    ["codebuddy", false, true], ["codebuddy", false, false], ["codebuddy", true, true],
  ] as const)(`${shell}: %s login exists=%s, accepts=%s`, (executor, loggedIn, accepts) => {
    // Execute the real login branch with fake command/prompt boundaries. No credentials are read.
    const code = `
      $ErrorActionPreference='Stop'
      [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
      $tree=[System.Management.Automation.Language.Parser]::ParseFile($env:PMA_INSTALLER,[ref]$null,[ref]$null)
      $branch=$tree.Find({param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if (!$TestMode') -and $n.Extent.Text.Contains('现在登录 ${executor === "codex" ? "Codex" : "CodeBuddy"} 吗？')},$true)
      if (!$branch) { throw 'missing login branch' }
      $TestMode=$false; $ConfigDir='C:\\fixture-config'; $versionPath='C:\\fixture-version'
      $config=[PSCustomObject]@{executor='${executor}'}; $env:USERPROFILE='C:\\fixture-profile'
      $global:prompts=@(); $global:calls=@(); $global:paths=@()
      function Test-Path { param($LiteralPath) $global:paths+=$LiteralPath; return $${loggedIn} }
      function Confirm-Member($Prompt,$Testing) { $global:prompts+=$Prompt; return $${accepts} }
      function Invoke-MemberCommand($VersionPath,$Command) { $global:calls+=$Command; return 0 }
      Invoke-Expression $branch.Extent.Text
      @{prompts=@($global:prompts);calls=@($global:calls);paths=@($global:paths)}|ConvertTo-Json -Compress
    `;
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], {
      encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, PMA_INSTALLER: installer },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const actual = JSON.parse(result.stdout.trim());
    expect(actual.prompts).toEqual(loggedIn ? [] : [`现在登录 ${executor === "codex" ? "Codex" : "CodeBuddy"} 吗？`]);
    expect(actual.calls).toEqual(!loggedIn && accepts ? ["login"] : []);
    expect(actual.paths).toContain(executor === "codex" ? "C:\\fixture-config\\codex-home\\auth.json" : "C:\\fixture-profile\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\Tencent-Cloud.coding-copilot.info");
  });
}
