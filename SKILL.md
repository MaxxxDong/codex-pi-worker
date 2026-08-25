---
name: pi-worker
description: Delegate bounded repository analysis, code review, implementation, repair, code search, or web research to Pi through configured OpenCode Go, ShuaiAPI, or Krill models. Supports receipt-bound continuation, isolated Git worktrees for writes, review-gated cleanup, a shared 20 GiB dependency cache, parallel detached runs, Windows completion-event watch, and structured results. Use when Codex should offload substantial work to Pi.
---

# Pi Worker

Pi executes the bounded task; Codex reviews the result and verifies material changes.

1. Write one UTF-8 prompt with scope, deliverable, and focused checks. Do not include secrets.
2. Use the default `implementation` mode unless the task is explicitly read-only. Implementation
   snapshots current non-ignored WIP into an isolated worktree without modifying or stashing the source.
3. Start detached with a unique output directory. Add `--evidence-file <path>` for each external file
   the Worker must process with commands; it receives a private worktree copy.

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\start_pi_worker.py" `
  --cwd C:\absolute\repo --prompt-file C:\absolute\task.md `
  --output-dir C:\absolute\evidence
```

4. Wait once; never replace it with status polling, log tails, or periodic narration.

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\watch_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --timeout-seconds 1800
```

For parallel runs in one Codex task, pass all live receipts to one watch. Handle the first
`attention` or terminal event, remove only terminal receipts, then watch the rest. Different
Codex tasks must not consume the same receipt.

On `attention`, steer or cancel the same receipt. On terminal, review and either continue the
same session or finalize it. Read [docs/operations.md](docs/operations.md) only for these controls.
After review, always settle the receipt; use `--changes-integrated` only after accepted changes
have been applied or committed.

```powershell
python "$env:USERPROFILE\.codex\skills\pi-worker\scripts\finalize_pi_worker.py" `
  C:\absolute\evidence\pi-receipt.json --decision accepted --changes-integrated
```

Use `--decision rejected` for discarded work and finalize analysis runs too.

- Parallelize only independent write scopes; run expensive repository-wide gates once after integration.
- `completed` means execution ended, not that the result is correct.
- Never print or copy `~/.pi/agent/models.json`; it contains provider credentials.
