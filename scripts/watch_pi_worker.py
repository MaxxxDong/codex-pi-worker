#!/usr/bin/env python3
"""Wait for the next Pi worker completion using the Windows process event."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import sys
import time
from ctypes import wintypes
from pathlib import Path

from runtime_support import (
    close_windows_handle,
    create_attention_event,
    emit_json,
    record_job,
    release_cache,
    reset_attention_event,
)

SYNCHRONIZE = 0x00100000
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x00000102
FALLBACK_MS = 15_000
FINAL_TEXT_LIMIT = 2048


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def latest_receipt(path: Path) -> tuple[Path, dict[str, object]]:
    supplied = read_json(path)
    owner_path = Path(str(supplied.get("ownerReceiptPath") or path)).resolve()
    owner = read_json(owner_path)
    latest_path = Path(str(owner.get("latestReceiptPath") or path)).resolve()
    return latest_path, read_json(latest_path)


def lifecycle_state(receipt: dict[str, object]) -> str | None:
    try:
        owner_path = receipt.get("ownerReceiptPath")
        owner = read_json(Path(str(owner_path)).resolve()) if owner_path else receipt
        root = Path(str(owner["runtimeRoot"])).resolve()
        job = read_json(root / "jobs" / f"{owner['runId']}.json")
        return str(job["state"])
    except (KeyError, OSError, ValueError):
        return None


def compact_result(result: dict[str, object], result_path: Path) -> dict[str, object]:
    keys = (
        "runId", "status", "mode", "provider", "model", "thinking", "exitCode", "timedOut",
        "elapsedSeconds", "stopReason", "providerError", "reason", "reasonCode", "reasoningWarning", "usage",
        "toolErrorCount", "sourceDriftDetected", "changedFiles", "sessionId", "turnIndex",
        "cleanupStatus", "reviewRequired", "continuationAvailable", "patchPath", "worktreePath",
        "evidenceTruncated", "error", "stderrPath", "warnings", "attention", "attentions",
    )
    compact = {key: result[key] for key in keys if key in result}
    final_text = str(result.get("finalText") or "")
    compact.update(
        finalText=final_text[:FINAL_TEXT_LIMIT],
        finalTextTruncated=bool(result.get("finalTextTruncated")) or len(final_text) > FINAL_TEXT_LIMIT,
        resultPath=str(result_path),
    )
    return compact


def terminal(receipt_path: Path, receipt: dict[str, object], *, full: bool = False) -> dict[str, object] | None:
    result_path = Path(str(receipt["resultPath"]))
    if not result_path.is_file():
        return None
    result = read_json(result_path)
    event = {
        "event": "terminal",
        "receipt": str(receipt_path),
        "result": result if full else compact_result(result, result_path),
        "lifecycleState": lifecycle_state(receipt),
        "watchDeliveryLatencySeconds": round(max(0.0, time.time() - result_path.stat().st_mtime), 3),
    }
    attention_path = receipt.get("attentionPath")
    if attention_path and Path(str(attention_path)).is_file():
        # Completion wins the wait, but must not hide the last runtime warning.
        event["attention"] = read_json(Path(str(attention_path)))
    return event


def consumer_name(value: str) -> str:
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", value):
        raise argparse.ArgumentTypeError("consumer must be 1-64 letters, digits, dots, underscores, or hyphens")
    return value


def default_consumer() -> str:
    value = os.environ.get("CODEX_THREAD_ID") or "default"
    try:
        return consumer_name(value)
    except argparse.ArgumentTypeError:
        return "default"


def attention(
    receipt_path: Path, receipt: dict[str, object], consumer: str = "default"
) -> dict[str, object] | None:
    value = receipt.get("attentionPath")
    if not value:
        return None
    attention_path = Path(str(value))
    # Old watchers moved the only payload into a default-consumer delivery file.
    # Those payloads remain available to named consumers, without replaying them
    # to the default consumer. New claims never remove the shared source.
    payloads = []
    current_sequence = None
    if attention_path.is_file():
        payload = read_json(attention_path)
        current_sequence = int(payload.get("sequence") or 1)
        payloads.append(payload)
    if consumer != "default":
        for source in sorted(attention_path.parent.glob("pi-attention-delivered-*.json")):
            match = re.fullmatch(r"pi-attention-delivered-(\d+)\.json", source.name)
            if match and int(match[1]) != current_sequence:
                payloads.append(read_json(source))
    for payload in payloads:
        sequence = int(payload.get("sequence") or 1)
        suffix = "" if consumer == "default" else "-" + hashlib.sha256(consumer.encode()).hexdigest()[:16]
        delivered = attention_path.with_name(f"pi-attention-delivered-{sequence:03d}{suffix}.json")
        try:
            with delivered.open("x", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=True)
        except FileExistsError:
            if not delivered.is_file():
                raise
            continue
        return {
            "event": "attention",
            "receipt": str(receipt_path),
            "attention": payload,
            "lifecycleState": lifecycle_state(receipt),
            "evidence": str(delivered),
            "consumer": consumer,
        }
    return None


def orphaned(receipt_path: Path, receipt: dict[str, object]) -> dict[str, object]:
    runtime = receipt.get("runtimeRoot")
    reconciliation = None
    if runtime:
        root = Path(str(runtime)).resolve()
        owner_path = receipt.get("ownerReceiptPath")
        owner = read_json(Path(str(owner_path)).resolve()) if owner_path else receipt
        job = record_job(
            root,
            str(owner.get("runId") or receipt.get("runId")),
            state="orphaned",
            pid=0,
            latestRunId=receipt.get("runId"),
            resultPath=receipt.get("resultPath"),
        )
        reconciliation = {"state": job["state"], "cache": release_cache(root, str(receipt.get("runId")))}
    output_dir = Path(str(receipt.get("outputDir") or receipt_path.parent)).resolve()
    return {
        "event": "orphaned",
        "receipt": str(receipt_path),
        "runId": receipt.get("runId"),
        "reason": "worker_exited_without_result",
        "outputDir": str(output_dir),
        "evidence": {
            "events": str(output_dir / "pi-events.jsonl"),
            "stderr": str(output_dir / "pi-stderr.log"),
            "runtimeStderr": str(output_dir / "runtime.stderr.log"),
        },
        "runtimeReconciliation": reconciliation,
        "lifecycleState": reconciliation["state"] if reconciliation else "orphaned",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipts", type=Path, nargs="+")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--consumer", type=consumer_name, default=default_consumer())
    parser.add_argument("--full", action="store_true", help="include the complete terminal result")
    args = parser.parse_args()
    if args.timeout_seconds < 0:
        parser.error("--timeout-seconds must be zero or positive")
    receipts = [latest_receipt(path.resolve()) for path in args.receipts]
    for path, receipt in receipts:
        event = terminal(path, receipt, full=args.full)
        if event:
            emit_json(event)
            return 0
        event = attention(path, receipt, args.consumer)
        if event:
            emit_json(event)
            return 0

    if sys.platform != "win32":
        raise SystemExit("event watch currently supports native Windows only")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForMultipleObjects.argtypes = (
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        wintypes.BOOL,
        wintypes.DWORD,
    )
    kernel32.WaitForMultipleObjects.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    handles: list[int] = []
    watched: list[tuple[str, Path, dict[str, object], int | None]] = []
    try:
        for path, receipt in receipts:
            handle = kernel32.OpenProcess(SYNCHRONIZE, False, int(receipt["pid"]))
            if not handle:
                event = terminal(path, receipt, full=args.full)
                if event:
                    emit_json(event)
                    return 0
                emit_json(orphaned(path, receipt))
                return 0
            event_name = receipt.get("attentionEventName")
            if event_name:
                attention_handle = create_attention_event(str(event_name))
                assert attention_handle is not None
                handles.append(attention_handle)
                watched.append(("attention", path, receipt, attention_handle))
            handles.append(int(handle))
            watched.append(("process", path, receipt, None))
        if len(handles) > 64:
            raise SystemExit("at most 32 attention-enabled receipts can be watched together")
        array_type = ctypes.c_void_p * len(handles)
        deadline = time.monotonic() + args.timeout_seconds
        while True:
            # Manual-reset events are shared hints: another consumer may reset
            # one before this waiter sees it. Durable files are authoritative;
            # a quiet, bounded local heartbeat closes that race without making
            # the calling model poll or serializing waits across workers.
            for path, receipt in receipts:
                event = terminal(path, receipt, full=args.full) or attention(path, receipt, args.consumer)
                if event:
                    emit_json(event)
                    return 0
            remaining_ms = max(0, round((deadline - time.monotonic()) * 1000))
            result = kernel32.WaitForMultipleObjects(
                len(handles), array_type(*handles), False, min(remaining_ms, FALLBACK_MS)
            )
            if result == WAIT_TIMEOUT:
                if time.monotonic() >= deadline:
                    emit_json({"event": "timeout", "running": [r[1]["runId"] for r in receipts]})
                    return 2
                continue
            index = result - WAIT_OBJECT_0
            if index < 0 or index >= len(watched):
                raise SystemExit(f"WaitForMultipleObjects failed: {ctypes.get_last_error()}")
            kind, path, receipt, attention_handle = watched[index]
            if kind == "attention":
                reset_attention_event(attention_handle)
                event = attention(path, receipt, args.consumer)
                if event:
                    emit_json(event)
                    return 0
                continue
            event = terminal(path, receipt, full=args.full)
            if not event:
                emit_json(orphaned(path, receipt))
                return 0
            emit_json(event)
            return 0
    finally:
        for handle in handles:
            close_windows_handle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
