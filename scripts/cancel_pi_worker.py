#!/usr/bin/env python3
"""Request cancellation of one receipt-owned Pi worker."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from runtime_support import (
    close_windows_handle,
    create_attention_event,
    emit_json,
    pid_alive,
    runtime_lock,
    set_attention_event,
)


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    if os.name != "nt":
        raise SystemExit("receipt-bound cancellation currently supports native Windows only")

    supplied_path = args.receipt.resolve()
    supplied = read_json(supplied_path)
    owner_path = Path(str(supplied.get("ownerReceiptPath") or supplied_path)).resolve()
    owner = read_json(owner_path)
    latest_path = Path(str(owner.get("latestReceiptPath") or owner_path)).resolve()
    latest = read_json(latest_path)
    result_path = Path(str(latest["resultPath"])).resolve()
    if result_path.is_file():
        emit_json({"event": "already_terminal", "receipt": str(latest_path), "result": str(result_path)})
        return 0

    event_name = latest.get("cancelEventName")
    if not event_name:
        raise SystemExit("receipt predates safe cancellation support")
    root = Path(str(owner["runtimeRoot"])).resolve()
    owner_run_id = str(owner["runId"])
    latest_run_id = str(latest["runId"])
    pid = int(latest.get("pid") or 0)
    with runtime_lock(root):
        job = read_json(root / "jobs" / f"{owner_run_id}.json")
        if job.get("state") not in {"starting", "running"}:
            raise SystemExit(f"worker is not running: {job.get('state')}")
        if job.get("latestRunId") != latest_run_id or int(job.get("pid") or 0) != pid:
            raise SystemExit("receipt no longer owns the active Pi process")
        if not pid_alive(pid):
            raise SystemExit("worker process is no longer alive; use watch to reconcile it")

    handle = create_attention_event(str(event_name))
    try:
        set_attention_event(handle)
        deadline = time.monotonic() + 5
        while pid_alive(pid) and not result_path.is_file() and time.monotonic() < deadline:
            time.sleep(0.05)
    finally:
        close_windows_handle(handle)
    emit_json(
        {
            "event": "cancel_requested",
            "receipt": str(latest_path),
            "runId": latest_run_id,
            "resultReady": result_path.is_file(),
            "nextAction": "watch",
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
