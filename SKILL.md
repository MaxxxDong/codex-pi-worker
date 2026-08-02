---
name: pi-worker
description: Delegate bounded repository analysis, code review, implementation, repair, code search, or web research to Pi through configured OpenCode Go, ShuaiAPI, or Krill models. Supports receipt-bound continuation, isolated Git worktrees for writes, review-gated cleanup, a shared 20 GiB dependency cache, parallel detached runs, Windows completion-event watch, and structured results. Use when Codex should offload substantial work to Pi.
---

# Pi Worker

Use Pi as an executor. Codex remains responsible for reviewing its result and
verifying material changes.

## Workflow

1. Write one bounded UTF-8 prompt with scope, deliverable, and focused checks.
   Do not include secrets.
2. Normal work defaults to `implementation`; it can read, search, edit, and run
   checks in an isolated worktree. Use `--mode analysis` only when the task is
   explicitly read-only.
3. Start detached with a unique output directory:

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\start_pi_worker.py" `
  --cwd C:\absolute\repo --prompt-file C:\absolute\task.md `
  --output-dir C:\absolute\evidence
```

4. Wait once. Resume the same yielded shell process/cell; never replace it with
   status polling, log tails, or periodic narration.

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\watch_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --timeout-seconds 1800
```

An `attention` event needs handling, then one more watch on the same receipt.
A terminal result needs Codex review. For a focused correction, reuse the same
session and worktree:

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\continue_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --prompt-file C:\absolute\correction.md
```

After review, always settle the receipt. Add `--changes-integrated` only after
accepted implementation changes have been applied or committed.

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\finalize_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --decision accepted --changes-integrated
```

Use `--decision rejected` for discarded work. Finalize analysis runs too.

## Rules

- Parallelize independent tasks only; implementation write scopes must not overlap.
- Give each Worker one cohesive deliverable and focused checks. Run expensive
  repository-wide gates once after integration.
- Default route is `opencode-go/deepseek-v4-flash` with `max`; override provider,
  model, or thinking only when the task requires it.
- Add `--context-mode` only for large logs/files or repository-wide aggregation.
- Both modes have `read/grep/find/ls` and web search. Add `--firecrawl` for a
  Firecrawl task. Add `--playwright` only for browser work (implementation mode).
- Treat `status=completed` as execution completion, not proof of correctness.
- Never print or copy `~/.pi/agent/models.json`; it contains provider credentials.
- Use grok-worker when strict schema gates or live mid-run steering is required.
