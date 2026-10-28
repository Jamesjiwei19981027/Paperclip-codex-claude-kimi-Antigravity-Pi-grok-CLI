import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("reinstallation confirmation defaults", () => {
  for (const shell of ["powershell.exe", "pwsh.exe"]) {
    it(`${shell}: Enter reuses configuration while other confirmations still default to no`, () => {
      const library = fileURLToPath(new URL("../installer/uninstall.ps1", import.meta.url)).replaceAll("'", "''");
      const code = `
        . '${library}' -Library
        $global:prompts = @()
        function Read-Host([string]$Prompt) { $global:prompts += $Prompt; return $global:answer }
        $values = @()
        foreach ($inputValue in @('', 'y', 'yes', 'n', 'no', 'invalid')) {
          $global:answer = $inputValue
          $values += (Confirm-Member 'reuse' $false $false -DefaultYes)
        }
        $global:answer = ''
        $other = Confirm-Member 'other' $false
        @{ values=$values; other=$other; prompts=$global:prompts } | ConvertTo-Json -Compress
      `;
      const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      const actual = JSON.parse(result.stdout.trim());
      expect(actual.values).toEqual([true, true, true, false, false, false]);
      expect(actual.other).toBe(false);
      expect(actual.prompts.slice(0, 6)).toEqual(Array(6).fill("reuse [Y/n]"));
      expect(actual.prompts[6]).toBe("other [y/N]");
    });
  }
});
