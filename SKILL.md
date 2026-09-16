---
name: subworker
description: Delegate bounded repository analysis, code review, implementation, repair, code search, or web research to Pi, Agy, Claude Code, or Grok Build while the host IDE reviews the result. Supports receipt-bound continuation, isolated Git worktrees for writes, review-gated cleanup, a shared 20 GiB dependency cache, parallel detached runs, completion-event watch, and structured results.
---

# Subworker

Subworker is a background agent orchestrator for multi-host IDEs (such as Codex). The host IDE breaks down tasks, reviews patches, runs independent verification, and decides whether to accept or reject changes.

On macOS, Subworker orchestrates Pi, Agy, Claude Code, or Grok Build through `macos/bin/subworker`.
On Windows, Subworker orchestrates Pi through Python scripts.

## Windows Workflow

1. Write one bounded UTF-8 prompt with scope, deliverable, and focused checks. Do not include secrets.
2. Normal work defaults to `implementation`; it can read, search, edit, and run checks in an isolated worktree. Use `--mode analysis` only when the task is explicitly read-only.
3. Start detached with a unique output directory:

```powershell
python "$env:USERPROFILE\.codex\skills\subworker\scripts\start_pi_worker.py" `
  --cwd C:\absolute\repo --prompt-file C:\absolute\task.md `
  --output-dir C:\absolute\evidence
```

4. Wait once. Resume the same yielded shell process/cell; never replace it with status polling, log tails, or periodic narration:

```powershell
python "$env:USERPROFILE\.codex\skills\subworker\scripts\watch_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --timeout-seconds 1800
```

An `attention` event needs handling. While the turn is still running on Windows, send one focused correction through Pi's native RPC steer, then watch again:

```powershell
python "$env:USERPROFILE\.codex\skills\subworker\scripts\steer_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --message-file C:\absolute\correction.md
```

A terminal result needs review. For a correction after terminal, reuse the same session and worktree:

```powershell
python "$env:USERPROFILE\.codex\skills\subworker\scripts\continue_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --prompt-file C:\absolute\correction.md
```

After review, always settle the receipt. Add `--changes-integrated` only after accepted implementation changes have been applied or committed:

```powershell
python "$env:USERPROFILE\.codex\skills\subworker\scripts\finalize_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --decision accepted --changes-integrated
```

Use `--decision rejected` for discarded work. Finalize analysis runs too.

## macOS Workflow

On macOS, use `/Users/max/.codex/skills/subworker/bin/subworker` as the sole entry point for Pi, Agy, Claude Code, and Grok Build:

```bash
SUBWORKER=/Users/max/.codex/skills/subworker/bin/subworker

# Dispatch implementation task
$SUBWORKER dispatch --run-id fix-1 --mode write --source /absolute/repo -- \
  --provider commandcode --model deepseek/deepseek-v4-flash --thinking max "Implement fix"

# Wait for completion or attention
$SUBWORKER wait --run-id fix-1 --timeout 86400

# Cleanup after review
$SUBWORKER cleanup --reviewed yes --run-id fix-1
```

See `macos/SKILL.md` and `docs/macos.md` for full macOS capabilities and backend options.

## Rules & Boundaries

- Parallelize independent tasks only; implementation write scopes must not overlap.
- Give each Worker one cohesive deliverable and focused checks. Run expensive repository-wide gates once after integration.
- Treat `status=completed` as execution completion, not proof of correctness.
- Never print or copy `~/.pi/agent/models.json`; it contains provider credentials.
- Silent reminder (`--silent-reminder` / `--startup-attention`) is a soft notification, not a task lifetime limit.
- `--consumer <id>` scopes attention delivery receipts for independent conversation waiting.
- Persistent storage compatibility: `pi-worker/runs` physical directory is temporarily preserved.
- Standard environment variables are `SUBWORKER_*`; legacy `PI_WORKER_*` are supported as fallback.
