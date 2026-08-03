from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

from runtime_support import (
    atomic_json,
    close_windows_handle,
    create_attention_event,
    emit_json,
    pid_alive,
    runtime_root,
    set_attention_event,
    steer_event_name,
    steer_ack_event_name,
    wait_windows_event,
)


MAX_STEER_BYTES = 64 * 1024


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--message-file", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=10)
    args = parser.parse_args()
    if os.name != "nt":
        raise SystemExit("live steer currently requires Windows named events")

    supplied = read_json(args.receipt.resolve())
    owner_path = Path(str(supplied.get("ownerReceiptPath") or args.receipt)).resolve()
    owner = read_json(owner_path)
    latest_path = Path(str(owner.get("latestReceiptPath") or owner_path)).resolve()
    receipt = read_json(latest_path)
    if not receipt.get("steerAvailable") or not receipt.get("steerEventName") or not receipt.get("steerQueueDir"):
        raise SystemExit("receipt predates live steer support; wait for terminal and use continuation")
    result_path = Path(str(receipt["resultPath"])).resolve()
    if result_path.is_file() or not pid_alive(int(receipt.get("pid") or 0)):
        raise SystemExit("Pi turn is already terminal; use continuation instead")

    message = args.message_file.resolve().read_text(encoding="utf-8")
    if not message.strip():
        raise SystemExit("steer message is empty")
    if len(message.encode("utf-8")) > MAX_STEER_BYTES:
        raise SystemExit(f"steer message exceeds {MAX_STEER_BYTES} bytes")

    root = runtime_root().resolve()
    run_id = str(receipt["runId"])
    queue_dir = (root / "runs" / run_id / "steer").resolve()
    expected_event = steer_event_name(run_id)
    if Path(str(receipt["steerQueueDir"])).resolve() != queue_dir or receipt["steerEventName"] != expected_event:
        raise SystemExit("receipt steer control path does not match the active runtime")
    queue_dir.mkdir(parents=True, exist_ok=True)
    (queue_dir / "acks").mkdir(exist_ok=True)

    message_id = f"steer-{uuid.uuid4()}"
    ack_path = queue_dir / "acks" / f"{message_id}.json"
    ack_handle = create_attention_event(steer_ack_event_name(message_id))
    steer_handle = create_attention_event(expected_event)
    try:
        atomic_json(
            queue_dir / f"{message_id}.json",
            {"id": message_id, "type": "steer", "message": message},
        )
        set_attention_event(steer_handle)
        acknowledged = wait_windows_event(ack_handle, args.timeout_seconds)
        ack = read_json(ack_path) if acknowledged and ack_path.is_file() else {}
    finally:
        close_windows_handle(steer_handle)
        close_windows_handle(ack_handle)

    accepted = bool(ack.get("success"))
    emit_json(
        {
            "runId": receipt["runId"],
            "messageId": message_id,
            "acknowledged": acknowledged,
            "accepted": accepted,
            "error": ack.get("error"),
        }
    )
    ack_path.unlink(missing_ok=True)
    return 0 if acknowledged and accepted else 2


if __name__ == "__main__":
    sys.exit(main())
