#!/usr/bin/env python3
"""Windows command entry point over the existing Pi lifecycle scripts."""

from __future__ import annotations

import argparse
import json
import os
import runpy
import shutil
import subprocess
import sys
from pathlib import Path

from runtime_support import emit_json, pi_defaults, pid_alive

SCRIPTS = Path(__file__).resolve().parent
COMMANDS = {
    "dispatch": "start_pi_worker.py",
    "start": "start_pi_worker.py",
    "wait": "watch_pi_worker.py",
    "watch": "watch_pi_worker.py",
    "continue": "continue_pi_worker.py",
    "steer": "steer_pi_worker.py",
    "cancel": "cancel_pi_worker.py",
    "cleanup": "finalize_pi_worker.py",
    "finalize": "finalize_pi_worker.py",
}


def diagnose(path: Path) -> dict[str, object]:
    from watch_pi_worker import latest_receipt, lifecycle_state

    path, receipt = latest_receipt(path.resolve())
    output = Path(str(receipt["outputDir"]))
    result_path = Path(str(receipt["resultPath"]))
    result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.is_file() else {}
    progress_path = output / "pi-progress.json"
    progress = json.loads(progress_path.read_text(encoding="utf-8")) if progress_path.is_file() else result.get("progress")
    alive = pid_alive(int(receipt.get("pid") or 0))
    attention_path = output / "pi-attention.json"
    alert = json.loads(attention_path.read_text(encoding="utf-8")) if attention_path.is_file() else {}
    kind = str(alert.get("category") or result.get("stopReason") or "")
    if any(word in kind for word in ("auth", "permission", "config")):
        guidance = "check_configuration"
    elif alive and any(word in kind for word in ("provider", "retry", "transport", "rate_limit")):
        guidance = "wait_native_retry_or_steer"
    elif result.get("status") in {"failed", "cancelled"}:
        guidance = "review_partial_output_before_continue"
    else:
        guidance = None
    return {
        "receipt": str(path), "runId": receipt.get("runId"),
        "state": lifecycle_state(receipt), "processAlive": alive,
        "mode": receipt.get("mode"), "provider": receipt.get("provider"),
        "model": receipt.get("model"), "thinking": receipt.get("thinking"),
        "permissionProfile": receipt.get("permissionProfile", "legacy-guarded"),
        "executionCwd": receipt.get("executionCwd"), "resultPath": str(result_path),
        "status": result.get("status"), "stopReason": result.get("stopReason"),
        "progress": progress, "attentionCategory": kind or None, "retryGuidance": guidance,
        "providerRetryCount": result.get("providerRetryCount"),
        "cleanupStatus": result.get("cleanupStatus", receipt.get("cleanupStatus")),
    }


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in {"help", "--help", "-h"}:
        print("Subworker Windows (Pi): dispatch, wait, continue, steer, cancel, cleanup, diagnose, profiles")
        print("Use <command> --help for arguments. Windows uses receipts; macOS uses --run-id.")
        return 0
    command, *args = sys.argv[1:]
    if command == "--version":
        print((SCRIPTS.parent / "VERSION").read_text(encoding="utf-8").strip() + " (Windows Python)")
        return 0
    if command in COMMANDS:
        sys.argv = [str(SCRIPTS / COMMANDS[command]), *args]
        runpy.run_path(sys.argv[0], run_name="__main__")
        return 0
    if command == "diagnose":
        parser = argparse.ArgumentParser()
        parser.add_argument("receipts", type=Path, nargs="+")
        parsed = parser.parse_args(args)
        emit_json({"runs": [diagnose(path) for path in parsed.receipts]})
        return 0
    if command == "profiles":
        provider, model, thinking = pi_defaults()
        emit_json({"defaultProvider": provider, "defaultModel": model, "defaultThinking": thinking})
        executable = os.environ.get("SUBWORKER_PI_BIN") or os.environ.get("PI_WORKER_PI_BIN") or shutil.which("pi.cmd") or shutil.which("pi")
        if not executable:
            raise SystemExit("Pi CLI not found")
        return subprocess.run([executable, "--list-models", *args], check=False,
                              creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0).returncode
    raise SystemExit(f"unknown command: {command}; use help")


if __name__ == "__main__":
    raise SystemExit(main())
