CodeBuddy fixtures come from real CLI stdout captures in the `cb-probe/out` probe:

- `codebuddy-tools.jsonl`: `p4-tools.stdout.jsonl` (init, PowerShell tool call/result, assistant, success).
- `codebuddy-default.jsonl`: `p2-default.stdout.jsonl` (success followed by a duplicate init for the same session).
- `codebuddy-auth-failure.jsonl`: `p3-isolated-noauth.stdout.jsonl` (missing authentication and an error result).

The probe's elapsed-milliseconds/tab prefix was removed. JSON fields, ordering,
value types, usage counts, and tool-use/result relationships are preserved.
Paths, account/API source information, metadata strings, identifiers, installed
tool/command names, and arbitrary command/output text use safe placeholders.
Authentication error details are replaced with a safe authentication-failure
message. The public protocol tool name `PowerShell` and the `DONE` marker remain.
The pre-existing Codex fixture is unchanged.
