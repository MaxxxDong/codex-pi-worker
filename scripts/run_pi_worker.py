#!/usr/bin/env python3
"""Run one bounded Pi task and emit a compact structured result."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path
from threading import Condition, Event, Thread

from runtime_support import (
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    DEFAULT_THINKING,
    MODEL_CHOICES,
    PROVIDER_MODELS,
    atomic_json,
    close_windows_handle,
    create_attention_event,
    emit_json,
    record_job,
    release_cache,
    remove_run_temp,
    set_attention_event,
    terminate_process_tree,
    utc_now,
    validate_route,
    worker_environment,
)

MAX_RAW_EVENT_BYTES = 8 * 1024**2
MAX_EVENT_LOG_BYTES = 16 * 1024**2
MAX_STDERR_LOG_BYTES = 8 * 1024**2
MAX_FINAL_TEXT_BYTES = 1024**2
MAX_TOOL_ERROR_BYTES = 2048

BASE_TOOLS = "read,bash,edit,write,grep,find,ls,web_search,fetch_content,get_search_content"
ANALYSIS_TOOLS = "read,grep,find,ls,web_search,fetch_content,get_search_content"
IMPLEMENTATION_GUIDANCE = (
    "The current working directory is the isolated execution worktree. Use relative paths for edits and commands. "
    "The source checkout and home may be inspected read-only, but never mutate or execute against them."
)

CREDENTIAL_PATTERNS = (
    re.compile(rb"(?i)(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+"),
    re.compile(rb"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(rb"(?i)(?<![A-Za-z0-9])(?:sk|nb)[-_][A-Za-z0-9_-]{8,}"),
)
GENERATED_PATH_PARTS = {"__pycache__", ".pytest_cache", ".playwright-cli"}


def redact_credentials(raw: bytes) -> bytes:
    redacted = CREDENTIAL_PATTERNS[0].sub(rb"\1[REDACTED]", raw)
    redacted = CREDENTIAL_PATTERNS[1].sub(rb"\1[REDACTED]", redacted)
    return CREDENTIAL_PATTERNS[2].sub(b"[REDACTED]", redacted)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--source-cwd", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, default=None)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--mode", choices=("analysis", "implementation"), default="implementation")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument(
        "--provider",
        choices=tuple(PROVIDER_MODELS),
        default=DEFAULT_PROVIDER,
    )
    parser.add_argument(
        "--model",
        choices=MODEL_CHOICES,
        default=DEFAULT_MODEL,
    )
    parser.add_argument(
        "--thinking",
        choices=("off", "minimal", "low", "medium", "high", "xhigh", "max"),
        default=DEFAULT_THINKING,
    )
    parser.add_argument("--context-mode", action="store_true")
    parser.add_argument("--firecrawl", action="store_true")
    parser.add_argument("--playwright", action="store_true")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--worktree-path", type=Path, default=None)
    parser.add_argument("--base-commit", default="")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--session-dir", type=Path, required=True)
    parser.add_argument("--owner-run-id", default=None)
    parser.add_argument("--turn-index", type=int, default=1)
    parser.add_argument("--allow-existing-changes", action="store_true")
    parser.add_argument("--attention-event-name", default=None)
    parser.add_argument("--launch-gated", action="store_true")
    return parser.parse_args()


ATTENTION_PATTERNS = (
    ("broken_pipe", re.compile(r"\bEPIPE\b|broken pipe", re.IGNORECASE)),
    (
        "provider_auth",
        re.compile(r"(?:HTTP|status(?: code)?|response)\s*[:=]?\s*(?:401|403)\b|unauthorized|forbidden", re.IGNORECASE),
    ),
    (
        "provider_rate_limit",
        re.compile(r"(?:HTTP|status(?: code)?|response)\s*[:=]?\s*429\b|rate.?limit", re.IGNORECASE),
    ),
    (
        "provider_unavailable",
        re.compile(
            r"(?:HTTP|status(?: code)?|response)\s*[:=]?\s*5\d\d\b|"
            r"service unavailable|bad gateway|gateway timeout|internal server error",
            re.IGNORECASE,
        ),
    ),
    (
        "transport_error",
        re.compile(r"ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|transport error|connection reset", re.IGNORECASE),
    ),
    (
        "reasoning_ignored",
        re.compile(r"reasoning effort; ignoring|reasoning is not supported|unsupported reasoning", re.IGNORECASE),
    ),
)


def classify_attention(line: str) -> str | None:
    for category, pattern in ATTENTION_PATTERNS:
        if pattern.search(line):
            return category
    return None


def git_changes(cwd: Path) -> list[str]:
    completed = subprocess.run(
        ["git", "status", "--short"],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False,
    )
    if completed.returncode != 0:
        return []
    return [line for line in completed.stdout.splitlines() if not is_generated_path(line[3:])]


def is_generated_path(value: str) -> bool:
    normalized = value.replace("\\", "/")
    return normalized.endswith(".pyc") or bool(GENERATED_PATH_PARTS.intersection(normalized.split("/")))


def compact_event(raw: bytes) -> bytes | None:
    if len(raw) > MAX_RAW_EVENT_BYTES:
        return None
    try:
        event = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    event_type = event.get("type")
    compact: dict[str, object]
    if event_type == "tool_execution_start":
        compact = {
            "type": event_type,
            "toolName": event.get("toolName"),
        }
    elif event_type == "tool_execution_end":
        compact = {
            "type": event_type,
            "toolName": event.get("toolName"),
            "isError": bool(event.get("isError")),
        }
        if compact["isError"]:
            encoded = redact_credentials(
                json.dumps(event.get("result"), ensure_ascii=False, default=str).encode("utf-8")
            )
            compact["errorSummary"] = encoded[:MAX_TOOL_ERROR_BYTES].decode("utf-8", errors="ignore")
    elif event_type == "message_end":
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            return None
        text = "".join(item.get("text", "") for item in message.get("content", []) if item.get("type") == "text")
        encoded = text.encode("utf-8")
        text_truncated = len(encoded) > MAX_FINAL_TEXT_BYTES
        if text_truncated:
            text = encoded[:MAX_FINAL_TEXT_BYTES].decode("utf-8", errors="ignore")
        compact = {
            "type": event_type,
            "message": {
                "role": "assistant",
                "provider": message.get("provider"),
                "model": message.get("model"),
                "stopReason": message.get("stopReason"),
                "usage": message.get("usage") or {},
                "content": [{"type": "text", "text": text}] if text else [],
                "contentTruncated": text_truncated,
            },
        }
    elif event_type in {"agent_end", "agent_settled"}:
        compact = {"type": event_type}
    else:
        return None
    compact["at"] = utc_now()
    return (json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def write_patch(cwd: Path, output_dir: Path, base_commit: str) -> dict[str, object] | None:
    if not base_commit:
        return None
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=cwd,
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False,
    ).stdout.split(b"\0")
    untracked_paths = [
        decoded
        for path in untracked
        if path and not is_generated_path(decoded := path.decode("utf-8", errors="surrogateescape"))
    ]
    for start in range(0, len(untracked_paths), 100):
        subprocess.run(
            ["git", "add", "-N", "--", *untracked_paths[start : start + 100]],
            cwd=cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
    completed = subprocess.run(
        [
            "git",
            "diff",
            "--binary",
            "--no-ext-diff",
            base_commit,
            "--",
            ".",
            ":(exclude)**/__pycache__/**",
            ":(exclude)**/.pytest_cache/**",
            ":(exclude)**/.playwright-cli/**",
            ":(exclude)**/*.pyc",
        ],
        cwd=cwd,
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout:
        return None
    patch_path = output_dir / "changes.patch"
    patch_path.write_bytes(completed.stdout)
    files = [
        path
        for path in subprocess.run(
            ["git", "diff", "--name-only", base_commit, "--", "."],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        ).stdout.splitlines()
        if not is_generated_path(path)
    ]
    return {
        "path": str(patch_path),
        "sha256": hashlib.sha256(completed.stdout).hexdigest(),
        "bytes": len(completed.stdout),
        "files": files,
    }


def schedule_cache_gc(runtime: Path) -> bool:
    if os.environ.get("PI_WORKER_DISABLE_CACHE_GC") == "1":
        return False
    command = [sys.executable, str(Path(__file__).with_name("cache_gc.py")), "--runtime-root", str(runtime)]
    try:
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
            close_fds=True,
        )
    except OSError:
        return False
    return True


def cleanup_run_temp(runtime: Path, run_id: str) -> dict[str, object]:
    try:
        remove_run_temp(runtime, run_id)
    except OSError as error:
        return {
            "status": "deferred",
            "error": redact_credentials(str(error).encode("utf-8"))[:500].decode("utf-8", errors="ignore"),
        }
    return {"status": "removed"}


def parse_events(path: Path) -> dict[str, object]:
    usage = {key: 0 for key in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")}
    tools: list[dict[str, object]] = []
    final_text = ""
    provider = None
    model = None
    stop_reason = None
    agent_ended = False
    final_text_truncated = False

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_type = event.get("type")
        if event_type == "agent_end":
            agent_ended = True
        elif event_type == "tool_execution_end":
            tool = {"name": event.get("toolName"), "error": bool(event.get("isError"))}
            if event.get("errorSummary"):
                tool["errorSummary"] = event["errorSummary"]
            tools.append(tool)
        elif event_type == "message_end":
            message = event.get("message", {})
            if message.get("role") != "assistant":
                continue
            provider = message.get("provider", provider)
            model = message.get("model", model)
            stop_reason = message.get("stopReason", stop_reason)
            final_text_truncated |= bool(message.get("contentTruncated"))
            current_usage = message.get("usage") or {}
            for key in usage:
                usage[key] += int(current_usage.get(key) or 0)
            text_parts = [item.get("text", "") for item in message.get("content", []) if item.get("type") == "text"]
            if text_parts:
                final_text = "".join(text_parts)

    return {
        "agentEnded": agent_ended,
        "provider": provider,
        "model": model,
        "stopReason": stop_reason,
        "usage": usage,
        "toolCalls": tools,
        "finalText": final_text,
        "finalTextTruncated": final_text_truncated,
    }


def main(args: argparse.Namespace | None = None) -> int:
    args = args or parse_args()
    run_id = args.run_id or str(uuid.uuid4())
    owner_run_id = args.owner_run_id or run_id
    validate_route(args.provider, args.model)
    if args.launch_gated and sys.stdin.buffer.read(1) != b"1":
        raise RuntimeError("Pi runner launch gate closed before receipt commit")
    cwd = args.cwd.resolve()
    source_cwd = args.source_cwd.resolve()
    source_root = args.source_root.resolve() if args.source_root else source_cwd
    runtime = args.runtime_root.resolve()
    worktree_path = args.worktree_path.resolve() if args.worktree_path else None
    prompt_file = args.prompt_file.resolve()
    output_dir = args.output_dir.resolve()
    if not cwd.is_dir():
        raise SystemExit(f"cwd is not a directory: {cwd}")
    if not prompt_file.is_file():
        raise SystemExit(f"prompt file does not exist: {prompt_file}")
    if args.timeout_seconds < 1:
        raise SystemExit("timeout must be positive")
    changes_before = git_changes(cwd)
    if args.mode == "implementation" and changes_before and not args.allow_existing_changes:
        raise SystemExit("implementation mode requires a clean git worktree")

    pi = shutil.which("pi.cmd" if os.name == "nt" else "pi")
    if not pi:
        raise SystemExit("pi executable not found on PATH")
    output_dir.mkdir(parents=True, exist_ok=True)
    events_path = output_dir / "pi-events.jsonl"
    stderr_path = output_dir / "pi-stderr.log"
    result_path = output_dir / "pi-result.json"
    attention_path = output_dir / "pi-attention.json"
    attention_handle = create_attention_event(args.attention_event_name) if args.attention_event_name else None
    attention_sent = Event()
    event_log_bytes = 0
    stderr_log_bytes = 0
    event_log_truncated = False
    stderr_log_truncated = False
    oversize_event_count = 0
    reasoning_ignored_seen = False

    def notify_attention(category: str) -> None:
        if attention_sent.is_set():
            return
        attention_sent.set()
        atomic_json(
            attention_path,
            {
                "runId": run_id,
                "category": category,
                "message": "Pi worker reported a runtime/provider error; inspect the redacted evidence log.",
                "at": utc_now(),
                "stderr": str(stderr_path),
            },
        )
        set_attention_event(attention_handle)

    enabled_tools = ANALYSIS_TOOLS if args.mode == "analysis" else BASE_TOOLS
    if args.firecrawl:
        enabled_tools += ",mcp"
    guidance = (
        IMPLEMENTATION_GUIDANCE
        if args.mode == "implementation"
        else "This is a read-only task. Inspect the current working directory without changing files or repository state."
    )
    command = [
        pi,
        "--mode",
        "json",
        "--print",
        "--session-id",
        args.session_id,
        "--session-dir",
        str(args.session_dir.resolve()),
        "--approve",
        "--provider",
        args.provider,
        "--model",
        args.model,
        "--thinking",
        args.thinking,
        "--append-system-prompt",
        guidance,
        "--extension",
        str(Path(__file__).with_name("pi_worker_guard.mjs")),
        "--tools",
        enabled_tools,
    ]
    if args.context_mode:
        agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent"))
        context_root = agent_dir / "npm" / "node_modules" / "context-mode"
        context_extension = context_root / "build" / "adapters" / "pi" / "extension.js"
        context_skills = context_root / "skills"
        if not context_extension.is_file() or not context_skills.is_dir():
            raise SystemExit(f"context-mode package is incomplete under {context_root}")
        command.extend(("--extension", str(context_extension), "--skill", str(context_skills)))
    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi" / "agent"))
    if args.firecrawl:
        adapter = agent_dir / "npm" / "node_modules" / "pi-mcp-adapter" / "index.ts"
        if not adapter.is_file():
            raise SystemExit(f"pi-mcp-adapter is not installed under {agent_dir}")
        command.extend(("--extension", str(adapter)))
    if args.playwright:
        if args.mode != "implementation":
            raise SystemExit("Playwright requires implementation mode")
        playwright_skills = agent_dir / "npm" / "node_modules" / "pi-playwright" / "skills"
        if not playwright_skills.is_dir():
            raise SystemExit(f"pi-playwright is not installed under {agent_dir}")
        command.extend(("--skill", str(playwright_skills)))
    flags = 0
    kwargs: dict[str, object] = {}
    if os.name == "nt":
        flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    started = time.perf_counter()
    timeout_event = Event()
    process_done = Event()
    activity = Condition()
    last_activity = time.monotonic()
    source_status_after: list[str] = []
    prompt = prompt_file.read_bytes()
    worker_env, _ = worker_environment(runtime, run_id)
    worker_env.update(
        {
            "PI_WORKER_MODE": args.mode,
            "PI_WORKER_SOURCE_CWD": str(source_cwd),
            "PI_WORKER_SOURCE_ROOT": str(source_root),
            "PI_WORKER_EXECUTION_CWD": str(cwd),
            "PI_WORKER_RUN_ID": run_id,
        }
    )
    cache_status: dict[str, object] = {}
    run_temp_cleanup: dict[str, object] = {"status": "pending"}
    try:
        with events_path.open("wb") as events_file, stderr_path.open("wb") as stderr_file:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=worker_env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=flags,
                **kwargs,
            )
            assert process.stdin is not None and process.stdout is not None and process.stderr is not None

            def mark_activity() -> None:
                nonlocal last_activity
                with activity:
                    last_activity = time.monotonic()
                    activity.notify()

            def copy_stderr() -> None:
                nonlocal stderr_log_bytes, stderr_log_truncated, reasoning_ignored_seen
                for raw in process.stderr:
                    safe_raw = redact_credentials(raw)
                    remaining = MAX_STDERR_LOG_BYTES - stderr_log_bytes
                    if remaining > 0:
                        written = safe_raw[:remaining]
                        stderr_file.write(written)
                        stderr_file.flush()
                        stderr_log_bytes += len(written)
                    if len(safe_raw) > remaining:
                        stderr_log_truncated = True
                    category = classify_attention(raw.decode("utf-8", errors="replace"))
                    if category:
                        reasoning_ignored_seen |= category == "reasoning_ignored"
                        notify_attention(category)

            stderr_thread = Thread(target=copy_stderr, name=f"pi-stderr-{run_id}", daemon=True)
            stderr_thread.start()

            def watch_idle() -> None:
                with activity:
                    while not process_done.is_set():
                        remaining = args.timeout_seconds - (time.monotonic() - last_activity)
                        if remaining <= 0:
                            timeout_event.set()
                            terminate_process_tree(process)
                            return
                        activity.wait(remaining)

            watchdog = Thread(target=watch_idle, name=f"pi-idle-{run_id}", daemon=True)
            watchdog.start()
            try:
                try:
                    process.stdin.write(prompt)
                    process.stdin.close()
                except BrokenPipeError:
                    notify_attention("broken_pipe")
                for raw in process.stdout:
                    if len(raw) > MAX_RAW_EVENT_BYTES:
                        oversize_event_count += 1
                        notify_attention("output_oversize")
                        continue
                    compact = compact_event(raw)
                    if compact is not None:
                        remaining = MAX_EVENT_LOG_BYTES - event_log_bytes
                        if len(compact) <= remaining:
                            events_file.write(compact)
                            events_file.flush()
                            event_log_bytes += len(compact)
                        else:
                            event_log_truncated = True
                            notify_attention("output_oversize")
                    try:
                        event = json.loads(raw)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        event = {}
                    if event.get("type") in {"tool_execution_start", "tool_execution_end", "message_end", "agent_end"}:
                        mark_activity()
                process.stdout.close()
                exit_code = process.wait()
                stderr_thread.join(timeout=5)
            finally:
                process_done.set()
                with activity:
                    activity.notify()
                watchdog.join(timeout=1)
    finally:
        close_windows_handle(attention_handle)
        try:
            run_temp_cleanup = cleanup_run_temp(runtime, run_id)
        finally:
            cache_status = release_cache(runtime, run_id)

    timed_out = timeout_event.is_set()

    parsed = parse_events(events_path)
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace")
    reasoning_warning = reasoning_ignored_seen or any(
        term in stderr_text.lower()
        for term in ("reasoning effort; ignoring", "reasoning is not supported", "unsupported reasoning")
    )
    if args.mode == "implementation":
        source_status_after = git_changes(source_root)
    tool_errors = sum(bool(item["error"]) for item in parsed["toolCalls"])
    completed = (
        exit_code == 0
        and not timed_out
        and parsed["agentEnded"]
        and parsed["provider"] == args.provider
        and parsed["model"] == args.model
        and parsed["stopReason"] == "stop"
        and not reasoning_warning
    )
    patch = write_patch(cwd, output_dir, args.base_commit)
    changes_after = git_changes(cwd)
    cache_gc_scheduled = bool(cache_status.get("gcEligible")) and schedule_cache_gc(runtime)
    result = {
        "runId": run_id,
        "status": "completed" if completed else "failed",
        "mode": args.mode,
        "provider": parsed["provider"],
        "model": parsed["model"],
        "thinking": args.thinking,
        "contextMode": bool(getattr(args, "context_mode", False)),
        "firecrawl": bool(getattr(args, "firecrawl", False)),
        "playwright": bool(getattr(args, "playwright", False)),
        "exitCode": exit_code,
        "timedOut": timed_out,
        "timeoutMode": "idle",
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "stopReason": parsed["stopReason"],
        "reasoningWarning": reasoning_warning,
        "evidenceTruncated": (
            event_log_truncated
            or stderr_log_truncated
            or bool(oversize_event_count)
            or bool(parsed["finalTextTruncated"])
        ),
        "evidenceLimits": {
            "eventLogBytes": MAX_EVENT_LOG_BYTES,
            "stderrLogBytes": MAX_STDERR_LOG_BYTES,
            "finalTextBytes": MAX_FINAL_TEXT_BYTES,
        },
        "eventLogTruncated": event_log_truncated,
        "stderrLogTruncated": stderr_log_truncated,
        "oversizeEventCount": oversize_event_count,
        "finalTextTruncated": parsed["finalTextTruncated"],
        "usage": parsed["usage"],
        "toolCalls": parsed["toolCalls"],
        "toolErrorCount": tool_errors,
        "worktreeStatusBefore": changes_before,
        "worktreeStatusAfter": changes_after,
        "sourceEscapeDetected": False,
        "sourceCheckoutChanged": bool(source_status_after),
        "sourceStatusAfter": source_status_after,
        "changedFiles": changes_after if args.mode == "implementation" else [],
        "finalText": parsed["finalText"],
        "sourceCwd": str(source_cwd),
        "sourceRoot": str(source_root),
        "executionCwd": str(cwd),
        "worktreePath": str(worktree_path) if worktree_path else None,
        "baseCommit": args.base_commit or None,
        "sessionId": args.session_id,
        "sessionDir": str(args.session_dir.resolve()),
        "turnIndex": args.turn_index,
        "cleanupStatus": "pending_review",
        "runTempCleanup": run_temp_cleanup,
        "reviewRequired": True,
        "continuationAvailable": True,
        "nextAction": "review_then_continue_or_finalize",
        "patch": patch,
        "cache": {
            "roots": {
                "uv": worker_env["UV_CACHE_DIR"],
                "pip": worker_env["PIP_CACHE_DIR"],
                "npm": worker_env["npm_config_cache"],
            },
            "limitBytes": 20 * 1024**3,
            "releaseStatus": cache_status,
            "gcScheduled": cache_gc_scheduled,
        },
        "evidence": {"events": str(events_path), "stderr": str(stderr_path)},
    }
    atomic_json(result_path, result)
    record_job(
        runtime,
        owner_run_id,
        state="pending_review",
        pid=0,
        latestRunId=run_id,
        resultPath=str(result_path),
        latestReceiptPath=str(output_dir / "pi-receipt.json"),
        worktreePath=str(worktree_path) if worktree_path else None,
        sessionDir=str(args.session_dir.resolve()),
        sourceRoot=str(source_root),
        outputDir=str(output_dir),
    )
    emit_json(result)
    return 0 if completed else 1


def write_runner_failure(args: argparse.Namespace, error: BaseException) -> int:
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    run_id = args.run_id or "unknown"
    attention_path = output_dir / "pi-attention.json"
    result = {
        "runId": run_id,
        "status": "failed",
        "mode": args.mode,
        "provider": args.provider,
        "model": args.model,
        "thinking": args.thinking,
        "contextMode": bool(getattr(args, "context_mode", False)),
        "firecrawl": bool(getattr(args, "firecrawl", False)),
        "playwright": bool(getattr(args, "playwright", False)),
        "exitCode": None,
        "timedOut": False,
        "stopReason": "runner_error",
        "runnerError": {
            "type": type(error).__name__,
            "message": redact_credentials(str(error).encode("utf-8"))[:500].decode("utf-8", errors="ignore"),
        },
        "sessionId": args.session_id,
        "sessionDir": str(args.session_dir.resolve()),
        "turnIndex": args.turn_index,
        "cleanupStatus": "pending_review",
        "reviewRequired": True,
        "continuationAvailable": True,
        "nextAction": "review_then_finalize",
    }
    atomic_json(
        attention_path,
        {
            "runId": run_id,
            "category": "runner_error",
            "message": "Pi runner failed; inspect runtime.stderr.log.",
            "at": utc_now(),
        },
    )
    atomic_json(output_dir / "pi-result.json", result)
    record_job(
        args.runtime_root.resolve(),
        getattr(args, "owner_run_id", None) or run_id,
        state="pending_review",
        pid=0,
        latestRunId=run_id,
        resultPath=str(output_dir / "pi-result.json"),
        latestReceiptPath=str(output_dir / "pi-receipt.json"),
    )
    try:
        remove_run_temp(args.runtime_root.resolve(), run_id)
        release_cache(args.runtime_root.resolve(), run_id)
    except (OSError, ValueError):
        pass
    if error.__traceback__ is not None:
        traceback.print_tb(error.__traceback__)
    print(f"{type(error).__name__}: {result['runnerError']['message']}", file=sys.stderr)
    emit_json(result)
    return 1


def failure_args_from_argv(argv: list[str]) -> argparse.Namespace | None:
    def value(name: str, default: str | None = None) -> str | None:
        try:
            return argv[argv.index(name) + 1]
        except (ValueError, IndexError):
            return default

    output_dir = value("--output-dir")
    runtime = value("--runtime-root")
    if not output_dir or not runtime:
        return None
    return argparse.Namespace(
        output_dir=Path(output_dir),
        runtime_root=Path(runtime),
        run_id=value("--run-id") or "unknown",
        owner_run_id=value("--owner-run-id"),
        mode=value("--mode", "unknown"),
        provider=value("--provider", DEFAULT_PROVIDER),
        model=value("--model", DEFAULT_MODEL),
        thinking=value("--thinking", DEFAULT_THINKING),
        context_mode="--context-mode" in argv,
        firecrawl="--firecrawl" in argv,
        playwright="--playwright" in argv,
        session_id=value("--session-id", "unknown"),
        session_dir=Path(value("--session-dir", str(Path(runtime) / "sessions" / "unknown"))),
        turn_index=int(value("--turn-index", "1") or 1),
    )


if __name__ == "__main__":
    parsed_args = None
    try:
        parsed_args = parse_args()
        code = main(parsed_args)
    except (Exception, SystemExit) as error:
        failure_args = parsed_args or failure_args_from_argv(sys.argv[1:])
        if failure_args is None:
            raise
        code = write_runner_failure(failure_args, error)
    sys.exit(code)
