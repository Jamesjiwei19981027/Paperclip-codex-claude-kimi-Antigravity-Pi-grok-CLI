# Local modifications

This file records the changes maintained in this downstream fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip). The upstream project and its contributors remain the foundation of this repository; its MIT license and copyright notice are retained in [`../LICENSE`](../LICENSE).

The fork was exported as a clean source snapshot on 2026-10-24. Development-agent rules, local credentials, machine-specific paths, private company state, and the previous local Git history were intentionally excluded from that export. The fork currently keeps its own Git history from the clean import onward.

## What this fork carries

### Adapter and Windows runtime work

- Improved Windows process-tree startup, cancellation, and termination behavior for CLI adapters.
- Added safer handling for standard npm command wrappers and multiline prompts.
- Added prompt-file paths for adapters that can exceed Windows command-line limits.
- Improved Gemini/Antigravity, Kimi CLI, Pi, Grok, and Claude adapter behavior and regression coverage.
- Added redaction around agent identity and signing-related runtime output.

### Paperclip execution and recovery work

- Added recovery wakes after provider subscription quota resets.
- Covered lost-wakeup paths around confirmations, stale queued runs, deferred execution, environment leases, and orphaned conversation recovery.
- Improved review-state validation so a rejected update does not stop the reviewer run prematurely.
- Improved Windows process liveness and signed exit-code handling for persisted run results.
- Improved cancellation handling for runs that never reached a provider process.

### Reusable local setup

- Added generic Windows setup templates under `company-setup/`.
- Setup scripts now take the target company through `PAPERCLIP_COMPANY_ID` instead of embedding a private company identifier.
- Git Bash discovery and instance paths are resolved from the local installation rather than a developer-specific path.
- Organization verification writes screenshots and temporary evidence outside the repository.
- Local development-agent instructions and private runtime state are excluded from the public fork; Paperclip product templates used at runtime remain available.

### Fork-level documentation and hygiene

- Added explicit upstream attribution and a link to the original repository in the README.
- Added local ignore rules for environment overrides, credentials, private keys, logs, generated evidence, and development-agent configuration.
- Added a clean-import history so this repository does not publish the original workstation's private commit history.

## Provenance notes

The original local development used Claude and Codex-assisted workflows. The source snapshot's earlier commits were authored under one Git identity and did not contain AI co-author trailers, so this document records model participation at the workflow level rather than assigning individual lines to a specific model. ZCode bridge configuration, Paperclip instance data, agent credentials, monitoring processes, and other external runtime state are not part of this source repository.

The fork's first clean-import commit is `5ebd9701`. Subsequent changes to this document or the fork should be recorded in normal Git commits and kept separate from upstream history.
