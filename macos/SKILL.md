---
name: subworker
description: Delegate implementation, repair, review, test, repository search, or web research through Pi, Agy, Claude Code, or Grok Build while the host IDE reviews the result.
---

# Subworker

Use `/Users/max/.codex/skills/subworker/bin/subworker` as the entry point. Run `profiles` for supported effort defaults and capabilities; `help` for syntax. Preserve the user's backend, model, and effort choices.

## Workspace and deliverable

- `--mode read --workdir DIR`: inspect without changing project files. Pi exposes read tools and prompt-constrained shell; Agy uses native `plan`; Claude uses `plan` plus a read-only system instruction. These are not equivalent OS sandboxes.
- `--mode write --source DIR`: use a managed detached Git worktree, including staged, unstaged, and non-ignored untracked source files in its baseline. Dirty source is allowed; keep writes inside the worktree or run-local `TMPDIR`.
- `--mode in-place --workdir DIR`: write directly in the assigned directory, including non-Git document workspaces. Give concurrent writers separate directories or non-overlapping ownership.
- Provide scope, necessary references, ownership, acceptance criteria, and a stopping point. Put required inputs within the assigned workspace when practical; do not broaden permissions to compensate for misplaced inputs.
- **Long documents and code belong in files** in an authorized write workspace. Request paths, a short summary, checks performed, and remaining issues in the final response. Do not require whole files in one JSON response unless the user or an actual consumer needs that interface. Use bounded chunks for output-only work; reserve JSON for suitable structured results.
- Allow editing tools available in the worker's runtime, subject to applicable instructions. Do not assume the host's `apply_patch` tool is an executable available there. If an explicitly required method is unavailable, require a blocker report rather than an unauthorized substitute.

## Dispatch and follow up

In Codex host, use `exec_command` with `sandbox_permissions="require_escalated"` for `dispatch`, `continue`, `steer`, `cancel`, and review-approved `cleanup`. Other hosts use their native terminal. This does not authorize changing global permissions.

For non-trivial prompts, create a prompt file and pass its contents as a quoted argument to prevent shell interpretation:

```bash
SUBWORKER=/Users/max/.codex/skills/subworker/bin/subworker
$SUBWORKER dispatch --backend agy --run-id draft-1 --mode in-place --workdir /absolute/assigned-dir -- \
  --model gemini-3.8-flash-high --effort high "$(< /absolute/task.md)"
$SUBWORKER wait --run-id draft-1 --timeout 60
$SUBWORKER continue --run-id draft-1 -- "Address the specific review findings, then stop."
```

The example model does not override a user selection. Other backend arguments:

| Backend | Selection and capabilities | Follow-up |
|---|---|---|
| Pi (default) | `--provider ID --model ID --thinking LEVEL`; optional `--capability docs`, `lens`, `context`, or `browser`; configured Pi skills load normally | `continue`; active `steer` requires dispatch with `--live` |
| Agy | Explicit `--model ID --effort LEVEL`; LEVEL is low, medium, or high (default high); write/in-place=`accept-edits`; native skills/MCP/plugins | `continue`; no live, steer, or capability flags |
| Claude Code | `--provider commandcode` or `native`, `--model ID --effort LEVEL`; CommandCode uses an ephemeral bridge with the Pi key; write=`auto`, in-place=`acceptEdits`; native skills/MCP/plugins | `continue`; no live, steer, or capability flags; internal orchestration disabled unless `--allow-orchestration` |
| Grok Build | `--backend grok --model grok-4.6 --effort xhigh` (defaults shown); native skills/MCP/plugins; runtime supplies bypass automatically | `continue` resumes the exact owned session; no live, steer, or capability flags |

Up to 10 concurrent runs. One `wait` accepts multiple `--run-id` arguments and returns `{ results, alerts, pending }` on completion or attention. Wait again only on pending IDs; respect host wait limits. Alert receipts use `--consumer` (default: `$CODEX_THREAD_ID`, otherwise `default`); use an explicit identity for independent non-Codex callers sharing runs.

## Review and recovery

- `success` means normal runtime completion with a non-empty response, **not task acceptance**. Inspect actual files and relevant checks. Validate JSON when the requested interface requires it.
- A failed run can contain useful files or `finalText`. Review before retrying; do not discard them or relabel native `ERROR` as success merely because text is complete. `continue` preserves the conversation and prior-turn history but resets current error/output fields.
- Use `diagnose --run-id ID` for configuration, alerts, and retry guidance. `providerRetryCount` counts observed native CLI retries; `null` means unknown. Fix auth/configuration/unsupported-parameter failures before retrying. While the CLI actively retries a transient error, wait rather than dispatch a duplicate. Guidance is advisory and does not block explicit `continue`.
- Stop via `cancel --run-id ID --reason "..." --timeout 30`; never kill the supervisor directly. Review `result.json` and `changes.patch` where present before `cleanup --reviewed yes --run-id ID` removes worktree/session/temp resources. Result-bearing runs are not automatically deleted.

## Operational boundaries

- Existing Agy `toolPermission=always-proceed` or Claude `permissions.defaultMode=bypassPermissions` causes explicit `--dangerously-skip-permissions`, recorded in `backendArgs` and diagnose. Do not change these settings without authorization. In bypass mode, task boundaries are instructions, not enforced isolation. Pi has no equivalent approval flag.
- Grok dispatch and continue automatically supply `--permission-mode bypassPermissions --always-approve`, recorded in `backendArgs` via the normalized bypass flag. Callers need not pass a permission option. This applies to read mode too: read-only scope is prompt-constrained, not enforced by native approvals. Global settings are unchanged. Cleanup deletes only the assigned local Grok session, not remote history or shared prompt history.
- Hard/idle timeouts are disabled by default. Startup attention defaults to 60s, silence reminder to 600s, and no-tool progress reminder to 600s in write/in-place or 0 in read mode. These are soft notifications, not cancellation; 0 disables each. Set `--hard-timeout` or `--idle-timeout` only when needed.
- Environment overrides use `SUBWORKER_*`; legacy `PI_WORKER_*` remains supported. Default state: `~/Library/Application Support/pi-worker/runs` on macOS, `~/.local/state/pi-worker/runs` elsewhere; override with `SUBWORKER_STATE_ROOT`. Review-gated cleanup also runs shared-cache LRU maintenance only when no peer worker is active (20 GiB limit).
