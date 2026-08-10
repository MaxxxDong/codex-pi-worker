---
name: pi-worker
description: Delegate implementation, repair, review, test, repository search, or web research to local Pi models while Codex reviews the result.
---

# Pi Worker

Use `/Users/max/.codex/skills/pi-worker/bin/pi-worker` as the only entry. Run `pi-worker profiles` for supported models, enforced thinking defaults, and optional capabilities; run `pi-worker help` for syntax.

## Efficient execution

- Run every `dispatch` and `continue` command through network-enabled `exec_command` with `sandbox_permissions="require_escalated"`; otherwise Pi inherits Codex's Seatbelt network block and reports misleading zero-Token `Connection error` retries. The wrapper now fails before creating a run when it detects that state.
- For non-trivial prompts, write the task to a file and pass it as `"$(< /absolute/task.md)"`; do not embed backticks or other shell-significant task text directly inside a double-quoted command.
- Read/review tasks run directly in the existing repository with `--mode read --workdir`. They receive `read`, `grep`, `find`, `ls`, `web_search`, and `bash`, but not `edit` or `write`; `bash` is restricted by the run prompt to inspection and commands known not to write project files.
- Workers start from named files, failing tests, and direct callers. They expand to repository-wide search only when the task explicitly requires it or targeted evidence is insufficient; output-only and connectivity checks do not call tools.
- Write tasks use `--mode write --source`; the runner creates a lightweight detached Git worktree and carries the source's tracked dirty and non-ignored untracked files into its baseline. Dirty state is not a startup gate.
- Worker instructions keep writes inside the current worktree or run-local `TMPDIR`; external paths remain readable when the task needs references.
- Use `--mode in-place --workdir` only when direct writes are intentional. Never overlap writers in one directory.
- Root may dispatch up to 10 independent Workers. One `wait` handles all run IDs and returns when any run succeeds, fails, is cancelled, or raises attention. Process `results` and `alerts`, then immediately call one new long `wait` with only the IDs in `pending`; do not poll `status` or use short wait timeouts as health checks. Independent Codex tasks may wait on the same run without overwriting each other.
- `result.json.state` follows one lifecycle only: `starting -> running -> stopping -> finalizing -> success|failed|cancelled`. `activity` is independent and may be `waiting_event`, `waiting_model`, or `running_tools`; `waiting_model` only means that no tool is active while Pi awaits the model, not that the Worker is reading files or making useful progress. `activitySeconds`, `firstToolAt`, `lastToolAt`, `lastEventType`, and `activeTools` make that distinction observable without retaining prompts or tool arguments.
- Worker completion freezes `result.json`, optional `changes.patch`, and failure-only `failure.log`. Raw streaming JSONL is not retained.
- Completion and later dispatches never delete a result-bearing run automatically. Codex reviews the result and patch first, then runs `cleanup --reviewed yes` to delete the run, session, and managed worktree.
- Each run gets a managed Pi session inside its run directory. `continue --run-id` reuses that session and the same worktree; review-gated cleanup deletes both. Private temporary files are still deleted before completion.
- While Pi is running, it uses a small writable profile copied from the current host configuration and keeps installed packages shared. This avoids global settings-lock failures inside Codex sandboxes; the supervisor deletes the temporary profile at terminal.
- All Workers reuse the same host npm, pnpm, uv, pip, and Poetry caches. Review cleanup performs GC only when no peer Worker is active: files unused for 90 days are removed first, then the oldest rebuildable files until the combined cache is at most 20 GiB. It never uses whole-cache purge commands.
- Headless Workers load configured Pi Skills plus the coding runtime. Context7, Lens, Context Mode, and Playwright are removed from automatic package discovery and load their matching extension/MCP plus Skill only through `--capability docs`, `lens`, `context`, or `browser`; runtime owns their paths and tool allowlists.
- Headless Workers pass Pi's native `--offline` switch so startup skips version, package, telemetry, and remote catalog checks; configured model requests still use the network normally.
- Success requires process exit `0` and Pi's `agent_settled` event. Hard and no-event idle timeouts are disabled by default; use `--hard-timeout` or `--idle-timeout` only when a task needs an explicit limit.
- `wait --timeout` limits only that waiting command. It never cancels a Worker. Use `cancel` to ask the supervisor to stop its child, finalize evidence, and return `cancelled`; never kill the supervisor directly.
- Normal dispatch and continuation use JSON headless mode. Add `--live` only when an active turn must accept `steer`; long ordinary tasks avoid RPC serialization overhead. Provider, transport, ignored-reasoning, repeated tool, extension, compaction, prompt, or RPC shutdown errors wake `wait` immediately with state `attention`.
- `result.json.usage` aggregates every assistant model call in the run, including nested cost fields, cache reads, and reported reasoning tokens. `reportedReasoningTokens` is provider-reported evidence, while `thinking` remains the requested level.

## Commands

```bash
PI_WORKER=/Users/max/.codex/skills/pi-worker/bin/pi-worker

# Read/review directly; runtime supplies and validates thinking.
$PI_WORKER dispatch --run-id review-1 --mode read --workdir /absolute/repo -- \
  --provider opencode-go --model deepseek-v4-flash "Review the requested scope."

# OpenCode Go DeepSeek is fixed to max. Any caller-supplied thinking level is
# normalized to max by the runtime; if it makes no progress, use another model.

# Write in a managed worktree.
$PI_WORKER dispatch --run-id fix-1 --mode write --source /absolute/repo -- \
  --provider shuaiapi --model gpt-5.6-luna --thinking xhigh \
  "Implement the bounded fix and run focused tests."

# Add optional extension/MCP + Skill capabilities before `--`; other configured Pi Skills load automatically.
$PI_WORKER dispatch --run-id docs-review --mode read --workdir /absolute/repo \
  --capability docs -- --provider krill-sol --model gpt-5.6-sol \
  "Verify against current library documentation."

# Returns on the first terminal/attention event; repeat only with `pending` IDs.
$PI_WORKER wait --run-id review-1 --run-id fix-1 --timeout 86400

# Cancel through the supervisor so evidence and cleanup remain consistent.
$PI_WORKER cancel --run-id fix-1 --reason "Task superseded" --timeout 30

# Redirect an explicitly live turn without restarting it.
$PI_WORKER dispatch --run-id live-fix --mode write --source /absolute/repo --live -- \
  --provider krill --model grok-4.5 "Implement the bounded fix."
$PI_WORKER steer --run-id live-fix -- "Stop broad searching; inspect the failing test and its direct caller."
$PI_WORKER wait --run-id live-fix --timeout 86400

# Continue a completed run with its managed session and worktree.
$PI_WORKER continue --run-id fix-1 -- "Address the review findings and rerun focused tests."
$PI_WORKER wait --run-id fix-1 --timeout 86400

# After Codex has reviewed or integrated the result.
$PI_WORKER cleanup --reviewed yes --run-id review-1 --run-id fix-1
```

Root reviews diffs and independently reruns risk-relevant tests. `cache-status` reports the shared npm, pnpm, uv, pip, Poetry, and Pi Lens cache total. `status` is diagnostic only; it derives process liveness and repairs every non-terminal run whose supervisor vanished, while `wait` keeps event-first behavior with a 15-second local process fallback.

Known model profiles retain their documented thinking defaults and constraints. A newly configured provider/model may run without a Worker release when dispatch supplies an explicit valid `--thinking` level; Pi remains responsible for resolving the model and credentials.
