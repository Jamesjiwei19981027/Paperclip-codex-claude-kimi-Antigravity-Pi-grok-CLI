# Reusable Windows company setup

These scripts are templates for a local Paperclip installation. They do not describe or verify an existing live company. Run them from a normal, non-administrator PowerShell in the repository checkout after installing dependencies and authenticating the relevant provider CLIs.

Start the development service with `./company-setup/start-paperclip.ps1`, or use `-Foreground` to keep build output in the terminal. The script preserves an explicit `npm_config_script_shell`; otherwise it locates Git Bash through an installed `git.exe`. Install Git for Windows if discovery fails. Background startup logs are under `.paperclip/windows-logs` relative to the checkout. The root Windows launcher waits for the default local service at <http://127.0.0.1:3100>.

Stop with `./company-setup/stop-paperclip.ps1`. It verifies checkout-specific development process identities, requires successful checks for running, queued, and scheduled-retry agent tasks, and preserves the service if those checks fail. For embedded PostgreSQL it verifies the instance data directory and process identity, then uses `pg_ctl.exe` beside the matching `postgres.exe`. It does not delete instance data. Do not run multiple development instances against one database.

The default instance lives under the current user profile in `.paperclip/instances/default`. Set `PAPERCLIP_HOME`, `PAPERCLIP_INSTANCE_ID`, and, when applicable, `PAPERCLIP_CONFIG` consistently with the service you are managing. The stop helper also honors a configured embedded database directory. For a different service port or an instance whose runtime configuration differs from the current shell, use the normal service management workflow instead of these default-port launch helpers.

Before any creation script, supply the target company's UUID explicitly:

```powershell
$env:PAPERCLIP_COMPANY_ID = '<target-company-uuid>'
./company-setup/01-create-claude-cto.ps1
./company-setup/02-create-codex-lead.ps1
./company-setup/03-create-gemini-executor.ps1
./company-setup/04-create-pi-validator.ps1
./company-setup/05-create-grok-reviewer.ps1
./company-setup/07-create-kimi-executor.ps1
```

The scripts reject a missing or invalid company UUID before an API call. They use the default local API and require access appropriate to that installation. Each returns an existing agent with the same name instead of creating or updating it. Review instructions and adapter configuration before use; edit existing agents through Paperclip when applying later template changes.

The template organization is a Claude technical director, a Codex technical lead, and separate implementation and verification roles. It retains these model defaults:

- Claude director: `claude-opus-5-5`.
- Codex lead: `gpt-6.1-sol`, using the normal `codex` command from PATH.
- Gemini implementation and verification: `gemini-3.8-flash-high`, using the Antigravity CLI flavor.
- Pi-named independent validation role: Kimi CLI with `kimi-code/k3`.
- Kimi implementer: `kimi-code/kimi-for-coding`.
- Optional Grok reviewer: `grok-build`. The lead's instructions currently direct review work to Pi rather than Grok; review that policy before activating this role.

Kimi uses the CLI engine and Git Bash. Set `KIMI_SHELL_PATH` to an installed Git Bash `bash.exe`, or allow discovery through `git.exe`; the WSL `bash.exe` launcher is rejected. Provider login and optional proxy settings belong to the operator's environment or agent configuration. No personal proxy, model catalog, or provider credentials are included. Store instance credentials using the normal Paperclip setup, never in company instructions or reports.

Roles receive their responsibilities through `instructionsBundle/AGENTS.md`. No default working directory is set: project tasks use their selected workspace, and other tasks use the normal agent workspace. For projects with multiple repositories, describe repository paths and ownership in the project and task instructions. Delegation and review evidence must be real Paperclip work, rather than statements that delegation happened.

Evidence, reports, screenshots, and temporary files belong outside the checkout. Use a task-specific directory under the OS temporary directory or an explicitly chosen external `PAPERCLIP_EVIDENCE_DIR`. The Grok reporting helper location is resolved from this checkout and passed as `PAPERCLIP_REPORT_HELPER`; its body files must remain in the OS temporary directory.

To inspect an organization created from all six templates, set its page URL or company URL prefix, then run the Playwright helper:

```powershell
$env:PAPERCLIP_ORG_URL = 'http://127.0.0.1:3100/<company-prefix>/org'
node ./company-setup/verify-org.mjs
```

Alternatively set `PAPERCLIP_COMPANY_PREFIX` instead of `PAPERCLIP_ORG_URL`. The helper checks the six template names and writes `organization.png` to a new external temporary directory, or beneath external `PAPERCLIP_EVIDENCE_DIR`, printing the resulting path. This check requires the service and a Playwright Chromium installation. A successful template check is evidence only for the installation tested; it does not replace repository tests or release checks.
