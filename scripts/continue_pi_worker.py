#!/usr/bin/env python3
"""Continue one terminal Pi worker in its receipt-owned session and worktree."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from runtime_support import (
    activate_cache,
    atomic_json,
    attention_event_name,
    emit_json,
    is_within,
    pid_alive,
    reconcile_jobs,
    record_job,
    release_cache,
    remove_owned_tree,
    reserve_cache,
    runtime_lock,
    runtime_root,
    steer_event_name,
    terminate_process_tree,
)


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=int, default=None)
    args = parser.parse_args()

    started = time.perf_counter()
    supplied_receipt = args.receipt.resolve()
    supplied = read_json(supplied_receipt)
    owner_path = Path(str(supplied.get("ownerReceiptPath") or supplied_receipt)).resolve()
    owner = read_json(owner_path)
    if owner.get("cleanupStatus") == "settled":
        raise SystemExit("worker is already finalized")
    if not owner.get("sessionDir") or not owner.get("sessionId"):
        raise SystemExit("receipt predates Pi session continuation; start a new Worker")

    latest_path = Path(str(owner.get("latestReceiptPath") or owner_path)).resolve()
    latest = read_json(latest_path)
    latest_result = Path(str(latest["resultPath"])).resolve()
    if pid_alive(int(latest.get("pid") or 0)) or not latest_result.is_file():
        raise SystemExit("previous Pi turn is not terminal")

    prompt_file = args.prompt_file.resolve()
    if not prompt_file.is_file():
        raise SystemExit(f"prompt file does not exist: {prompt_file}")

    root = Path(str(owner.get("runtimeRoot") or runtime_root())).resolve()
    reconciliation = reconcile_jobs(root)
    session_dir = Path(str(owner["sessionDir"])).resolve()
    sessions_root = (root / "sessions").resolve()
    if not session_dir.is_dir() or not is_within(session_dir, sessions_root):
        raise SystemExit(f"receipt session is missing or outside the owned root: {session_dir}")

    execution_cwd = Path(str(owner["executionCwd"])).resolve()
    if not execution_cwd.is_dir():
        raise SystemExit(f"execution cwd is missing: {execution_cwd}")

    run_id = str(uuid.uuid4())
    steer_queue_dir = (root / "runs" / run_id / "steer").resolve()
    turn_index = int(owner.get("lastTurnIndex") or 1) + 1
    output_dir = Path(str(owner["outputDir"])).resolve() / "turns" / f"turn-{turn_index:03d}"
    receipt_path = output_dir / "pi-receipt.json"
    result_path = output_dir / "pi-result.json"

    with runtime_lock(root):
        owner = read_json(owner_path)
        if owner.get("cleanupStatus") == "settled":
            raise SystemExit("worker is already finalized")
        if int(owner.get("lastTurnIndex") or 1) + 1 != turn_index:
            raise SystemExit("another continuation was allocated concurrently")
        output_dir.mkdir(parents=True, exist_ok=False)
        owner.update(
            {
                "latestReceiptPath": str(receipt_path),
                "lastTurnIndex": turn_index,
                "cleanupStatus": "pending_worker",
            }
        )
        atomic_json(owner_path, owner)

    timeout_seconds = args.timeout_seconds or int(owner.get("timeoutSeconds") or 1800)
    cache_status = reserve_cache(root, run_id)
    runner = Path(__file__).with_name("run_pi_worker.py")
    command = [
        sys.executable,
        str(runner),
        "--cwd",
        str(execution_cwd),
        "--source-cwd",
        str(owner["sourceCwd"]),
        "--source-root",
        str(owner["sourceRoot"]),
        "--prompt-file",
        str(prompt_file),
        "--mode",
        str(owner["mode"]),
        "--output-dir",
        str(output_dir),
        "--timeout-seconds",
        str(timeout_seconds),
        "--provider",
        str(owner["provider"]),
        "--model",
        str(owner["model"]),
        "--thinking",
        str(owner["thinking"]),
        "--run-id",
        run_id,
        "--runtime-root",
        str(root),
        "--base-commit",
        str(owner.get("baseCommit") or ""),
        "--session-id",
        str(owner["sessionId"]),
        "--session-dir",
        str(session_dir),
        "--owner-run-id",
        str(owner["runId"]),
        "--turn-index",
        str(turn_index),
        "--attention-event-name",
        attention_event_name(run_id),
        "--steer-event-name",
        steer_event_name(run_id),
        "--steer-queue-dir",
        str(steer_queue_dir),
        "--launch-gated",
    ]
    worktree = owner.get("worktreePath")
    if worktree:
        command.extend(("--worktree-path", str(worktree), "--allow-existing-changes"))
    if owner.get("contextMode"):
        command.append("--context-mode")
    if owner.get("firecrawl"):
        command.append("--firecrawl")
    if owner.get("playwright"):
        command.append("--playwright")

    stdout_file = (output_dir / "runtime.stdout.log").open("wb")
    stderr_file = (output_dir / "runtime.stderr.log").open("wb")
    flags = (
        subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        if os.name == "nt"
        else 0
    )

    def rollback() -> None:
        release_cache(root, run_id)
        turns_root = (Path(str(owner["outputDir"])).resolve() / "turns").resolve()
        if output_dir.exists():
            remove_owned_tree(output_dir, turns_root)
        with runtime_lock(root):
            restored_owner = read_json(owner_path)
            restored_owner.update(
                {
                    "latestReceiptPath": str(latest_path),
                    "lastTurnIndex": turn_index - 1,
                    "cleanupStatus": "pending_review",
                }
            )
            atomic_json(owner_path, restored_owner)
        record_job(
            root,
            str(owner["runId"]),
            state="pending_review",
            pid=0,
            latestReceiptPath=str(latest_path),
            resultPath=str(latest_result),
        )

    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=stdout_file,
            stderr=stderr_file,
            creationflags=flags,
            start_new_session=os.name != "nt",
            close_fds=True,
        )
    except BaseException:
        stdout_file.close()
        stderr_file.close()
        rollback()
        raise
    finally:
        stdout_file.close()
        stderr_file.close()
    assert process is not None
    receipt = {
        "runId": run_id,
        "pid": process.pid,
        "status": "running",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "receiptLatencySeconds": round(time.perf_counter() - started, 3),
        "resultPath": str(result_path),
        "attentionPath": str(output_dir / "pi-attention.json"),
        "attentionEventName": attention_event_name(run_id),
        "steerEventName": steer_event_name(run_id),
        "steerQueueDir": str(steer_queue_dir),
        "steerAvailable": os.name == "nt",
        "outputDir": str(output_dir),
        "sourceRoot": str(owner["sourceRoot"]),
        "sourceCwd": str(owner["sourceCwd"]),
        "executionCwd": str(execution_cwd),
        "worktreePath": worktree,
        "baseCommit": owner.get("baseCommit"),
        "sessionId": owner["sessionId"],
        "sessionDir": str(session_dir),
        "turnIndex": turn_index,
        "ownerReceiptPath": str(owner_path),
        "mode": owner["mode"],
        "provider": owner["provider"],
        "model": owner["model"],
        "thinking": owner["thinking"],
        "timeoutSeconds": timeout_seconds,
        "contextMode": bool(owner.get("contextMode")),
        "firecrawl": bool(owner.get("firecrawl")),
        "playwright": bool(owner.get("playwright")),
        "cleanupStatus": "pending_worker",
        "cacheStatusAtStart": cache_status,
        "runtimeRoot": str(root),
        "runtimeReconciliation": reconciliation,
        "nextAction": "watch",
    }
    try:
        activate_cache(root, run_id, process.pid)
        atomic_json(receipt_path, receipt)
        record_job(
            root,
            str(owner["runId"]),
            state="running",
            pid=process.pid,
            latestRunId=run_id,
            latestReceiptPath=str(receipt_path),
            resultPath=str(result_path),
        )
        assert process.stdin is not None
        process.stdin.write(b"1")
        process.stdin.close()
    except BaseException:
        terminate_process_tree(process)
        rollback()
        raise
    emit_json(receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
