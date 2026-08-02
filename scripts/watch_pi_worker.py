#!/usr/bin/env python3
"""Wait for the next Pi worker completion using the Windows process event."""

from __future__ import annotations

import argparse
import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

from runtime_support import (
    close_windows_handle,
    create_attention_event,
    emit_json,
    reset_attention_event,
)

SYNCHRONIZE = 0x00100000
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x00000102


def read_json(path: Path) -> dict[str, object]:
    import json

    return json.loads(path.read_text(encoding="utf-8"))


def terminal(receipt_path: Path, receipt: dict[str, object]) -> dict[str, object] | None:
    result_path = Path(str(receipt["resultPath"]))
    if not result_path.is_file():
        return None
    return {
        "event": "terminal",
        "receipt": str(receipt_path),
        "result": read_json(result_path),
        "watchDeliveryLatencySeconds": round(max(0.0, time.time() - result_path.stat().st_mtime), 3),
    }


def attention(receipt_path: Path, receipt: dict[str, object]) -> dict[str, object] | None:
    value = receipt.get("attentionPath")
    if not value:
        return None
    attention_path = Path(str(value))
    if not attention_path.is_file():
        return None
    payload = read_json(attention_path)
    delivered = attention_path.with_name("pi-attention-delivered.json")
    attention_path.replace(delivered)
    return {
        "event": "attention",
        "receipt": str(receipt_path),
        "attention": payload,
        "evidence": str(delivered),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipts", type=Path, nargs="+")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()
    receipts = [(path.resolve(), read_json(path.resolve())) for path in args.receipts]
    for path, receipt in receipts:
        event = terminal(path, receipt)
        if event:
            emit_json(event)
            return 0
        event = attention(path, receipt)
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
                event = terminal(path, receipt)
                if event:
                    emit_json(event)
                    return 0
                raise SystemExit(f"worker process is unavailable and has no result: {path}")
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
            remaining_ms = max(0, round((deadline - time.monotonic()) * 1000))
            result = kernel32.WaitForMultipleObjects(len(handles), array_type(*handles), False, remaining_ms)
            if result == WAIT_TIMEOUT:
                emit_json({"event": "timeout", "running": [r[1]["runId"] for r in receipts]})
                return 2
            index = result - WAIT_OBJECT_0
            if index < 0 or index >= len(watched):
                raise SystemExit(f"WaitForMultipleObjects failed: {ctypes.get_last_error()}")
            kind, path, receipt, attention_handle = watched[index]
            if kind == "attention":
                reset_attention_event(attention_handle)
                event = attention(path, receipt)
                if event:
                    emit_json(event)
                    return 0
                continue
            event = terminal(path, receipt)
            if not event:
                raise SystemExit(f"worker exited without result: {path}")
            emit_json(event)
            return 0
    finally:
        for handle in handles:
            close_windows_handle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
