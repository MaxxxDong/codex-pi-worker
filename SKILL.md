---
name: pi-worker
description: Delegate implementation, repair, review, repository search or research to Pi on Windows. Supports detached runs, native permissions, WIP worktrees, in-place tasks, independent completion/attention, steer, continuation and review-gated cleanup. macOS uses Subworker.
---

# Subworker / Pi Worker

Codex assigns one cohesive task, reviews files and verifies the result. Windows keeps the existing
`pi-worker` Skill path; the command entry is `scripts/subworker.py`. macOS instructions: [macos/SKILL.md](macos/SKILL.md).

1. Write a UTF-8 prompt with scope, ownership, deliverable and focused checks.
2. Dispatch with a unique output directory. Default `implementation` snapshots staged, unstaged
   and non-ignored untracked WIP into a worktree. Use `in-place` to work directly in the assigned
   directory (including non-Git work); `analysis` requests read-only work through instructions.

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\subworker.py" dispatch `
  --cwd C:\absolute\repo --prompt-file C:\absolute\task.md --output-dir C:\absolute\evidence
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\subworker.py" wait `
  C:\absolute\evidence\pi-receipt.json --timeout-seconds 60
```

3. Resume a yielded wait process instead of starting status/log polling. A wait timeout ends only
   the wait. Pass all pending receipts together; handle the first completion or attention and
   wait again on the rest. Different conversations use distinct `--consumer` values
   (default `CODEX_THREAD_ID`). Use `--full` only when the compact result is insufficient.
4. On attention, use `diagnose <receipt>` and steer the same run where useful. On terminal,
   inspect the candidate and focused checks; continue the session for a correction.
5. After review, run `cleanup <receipt> --decision accepted --changes-integrated` once changes
   are integrated, or `--decision rejected` for discarded work. In-place files are retained.

Defaults: current Pi provider/model/thinking, native environment, normal Skills/extensions/prompts,
full native tools, no extra guard and no forced timeout. `analysis` is not an enforced sandbox.
Use explicit `--guarded` only when requested; use `--timeout-seconds` on dispatch only for a real
idle limit. Startup/silence/no-tool reminders are soft notices (60/600/600 seconds; analysis no-tool=0).

Independent write ownership enables parallelism. Long code/reports belong in files, not final chat.
Use `--context-mode` for large logs/aggregation, `--firecrawl` when needed and `--playwright` for browser tasks.
Optional `--evidence-file` copies external inputs into implementation worktrees.
Command details, controls and limits: [docs/operations.md](docs/operations.md).
