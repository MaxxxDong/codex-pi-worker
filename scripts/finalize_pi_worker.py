#!/usr/bin/env python3
"""Delete one reviewed Pi worktree and mark its receipt settled."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

from runtime_support import (
    atomic_json,
    emit_json,
    is_within,
    pid_alive,
    record_job,
    remove_owned_tree,
    remove_run_temp,
    runtime_root,
    utc_now,
)


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def orphaned_result(
    root: Path,
    owner_path: Path,
    owner: dict[str, object],
    latest_path: Path,
    latest: dict[str, object],
) -> dict[str, object]:
    owner_run_id = str(owner.get("runId") or "")
    latest_run_id = str(latest.get("runId") or "")
    job_path = root / "jobs" / f"{owner_run_id}.json"
    if not job_path.is_file():
        raise SystemExit("orphaned worker job record is missing")
    job = read_json(job_path)
    if job.get("state") != "orphaned" or int(str(job.get("pid") or 0)) != 0:
        raise SystemExit("missing result can only be rejected after the worker is reconciled as orphaned")
    if (root / "active" / f"{latest_run_id}.json").exists():
        raise SystemExit("orphaned worker still has an active marker")
    if pid_alive(int(str(job.get("pid") or 0))):
        raise SystemExit("orphaned worker process is still alive")

    latest_output = Path(str(latest.get("outputDir") or "")).resolve()
    expected_result = (latest_output / "pi-result.json").resolve()
    actual_result = Path(str(latest.get("resultPath") or "")).resolve()
    checks = {
        "owner run": str(job.get("jobId") or "") == owner_run_id,
        "latest run": str(job.get("latestRunId") or "") == latest_run_id,
        "owner latest receipt": Path(str(owner.get("latestReceiptPath") or owner_path)).resolve() == latest_path,
        "job latest receipt": Path(str(job.get("latestReceiptPath") or "")).resolve() == latest_path,
        "latest owner receipt": Path(str(latest.get("ownerReceiptPath") or "")).resolve() == owner_path,
        "supplied output": latest_output == latest_path.parent,
        "result path": actual_result == expected_result == Path(str(job.get("resultPath") or "")).resolve(),
        "runtime root": Path(str(owner.get("runtimeRoot") or root)).resolve()
        == Path(str(latest.get("runtimeRoot") or root)).resolve()
        == root,
    }
    for field in ("sourceRoot", "worktreePath", "sessionDir"):
        checks[field] = job.get(field) == owner.get(field) == latest.get(field)
    failed = [name for name, valid in checks.items() if not valid]
    if failed:
        raise SystemExit(f"orphaned receipt identity mismatch: {', '.join(failed)}")
    evidence = {
        name: str(path)
        for name, path in {
            "events": Path(str(latest.get("outputDir"))) / "pi-events.jsonl",
            "stderr": Path(str(latest.get("outputDir"))) / "pi-stderr.log",
        }.items()
        if path.is_file()
    }
    return {
        "runId": latest_run_id,
        "status": "failed",
        "stopReason": "worker_exited_without_result",
        "syntheticResult": True,
        "mode": latest.get("mode"),
        "provider": latest.get("provider"),
        "model": latest.get("model"),
        "thinking": latest.get("thinking"),
        "sourceRoot": latest.get("sourceRoot"),
        "sourceCwd": latest.get("sourceCwd"),
        "executionCwd": latest.get("executionCwd"),
        "worktreePath": latest.get("worktreePath"),
        "sessionDir": latest.get("sessionDir"),
        "changedFiles": [],
        "patch": None,
        "evidence": evidence,
        "cleanupStatus": "pending_review",
        "reviewRequired": True,
        "continuationAvailable": False,
        "nextAction": "review_then_finalize_rejected",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--decision", choices=("accepted", "rejected"), required=True)
    parser.add_argument("--changes-integrated", action="store_true")
    args = parser.parse_args()

    supplied_receipt_path = args.receipt.resolve()
    supplied_receipt = read_json(supplied_receipt_path)
    receipt_path = Path(str(supplied_receipt.get("ownerReceiptPath") or supplied_receipt_path)).resolve()
    receipt = read_json(receipt_path)
    latest_receipt_path = Path(str(receipt.get("latestReceiptPath") or receipt_path)).resolve()
    latest_receipt = read_json(latest_receipt_path)
    if supplied_receipt_path not in {receipt_path, latest_receipt_path}:
        raise SystemExit("supplied receipt is not part of the owner/latest receipt chain")
    result_path = Path(str(latest_receipt["resultPath"])).resolve()
    if not result_path.is_file():
        if args.decision != "rejected":
            raise SystemExit("worker is not terminal: missing pi-result.json can only be rejected")
        root = Path(str(receipt.get("runtimeRoot") or runtime_root())).resolve()
        result = orphaned_result(root, receipt_path, receipt, latest_receipt_path, latest_receipt)
        atomic_json(result_path, result)
    else:
        result = read_json(result_path)
    if result.get("cleanupStatus") == "settled":
        emit_json({"status": "settled", "alreadyFinalized": True})
        return 0

    root = Path(str(receipt.get("runtimeRoot") or runtime_root())).resolve()
    worktree_value = receipt.get("worktreePath")
    worktree = Path(str(worktree_value)).resolve() if worktree_value else None
    if worktree is not None:
        owned_root = (root / "worktrees").resolve()
        if worktree == owned_root or not is_within(worktree, owned_root):
            raise SystemExit(f"refusing cleanup outside owned worktree root: {worktree}")
    has_changes = bool(result.get("patch") or result.get("changedFiles"))
    if args.decision == "accepted" and has_changes and not args.changes_integrated:
        raise SystemExit("accepted changes require --changes-integrated after Codex applies or commits them")

    if worktree is not None:
        source_root = Path(str(receipt["sourceRoot"])).resolve()
        completed = subprocess.run(
            ["git", "-C", str(source_root), "worktree", "remove", "--force", str(worktree)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
        git_error = completed.stderr.strip() if completed.returncode != 0 else ""
        if worktree.exists():
            try:
                remove_owned_tree(worktree, owned_root)
            except (OSError, ValueError) as exc:
                result["cleanupStatus"] = "failed"
                result["cleanupError"] = "; ".join(
                    part for part in (git_error, f"owned worktree cleanup failed: {exc}") if part
                )
                atomic_json(result_path, result)
                raise SystemExit(result["cleanupError"]) from exc
        subprocess.run(
            ["git", "-C", str(source_root), "worktree", "prune"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )

    session_value = receipt.get("sessionDir")
    session_dir = Path(str(session_value)).resolve() if session_value else None
    if session_dir is not None:
        sessions_root = (root / "sessions").resolve()
        if session_dir == sessions_root or not is_within(session_dir, sessions_root):
            raise SystemExit(f"refusing cleanup outside owned session root: {session_dir}")
        if session_dir.is_dir():
            remove_owned_tree(session_dir, sessions_root)
    for run_id in {str(receipt["runId"]), str(latest_receipt["runId"])}:
        remove_run_temp(root, run_id)
    settled_at = utc_now()
    result.update(
        {
            "cleanupStatus": "settled",
            "reviewDecision": args.decision,
            "changesIntegrated": bool(args.changes_integrated),
            "settledAt": settled_at,
            "reviewRequired": False,
            "continuationAvailable": False,
            "nextAction": "none",
        }
    )
    receipt.update({"status": "settled", "cleanupStatus": "settled", "settledAt": settled_at})
    latest_receipt.update({"status": "settled", "cleanupStatus": "settled", "settledAt": settled_at})
    atomic_json(result_path, result)
    atomic_json(receipt_path, receipt)
    if latest_receipt_path != receipt_path:
        atomic_json(latest_receipt_path, latest_receipt)
    record_job(
        root,
        str(receipt["runId"]),
        state="settled",
        pid=0,
        resultPath=str(result_path),
        latestReceiptPath=str(latest_receipt_path),
        worktreePath=None,
        sessionDir=None,
        settledAt=settled_at,
    )
    emit_json(
        {
            "status": "settled",
            "decision": args.decision,
            "worktreeRemoved": str(worktree) if worktree else None,
            "sessionRemoved": str(session_dir) if session_dir else None,
            "resultPath": str(result_path),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
