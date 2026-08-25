#!/usr/bin/env python3
"""Start a Pi worker in the background and return a receipt immediately."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from runtime_support import (
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    DEFAULT_THINKING,
    MODEL_CHOICES,
    PROVIDER_MODELS,
    SourceSnapshot,
    activate_cache,
    atomic_json,
    attention_event_name,
    cancel_event_name,
    capture_source_snapshot,
    emit_json,
    reconcile_jobs,
    record_job,
    release_cache,
    remove_job,
    remove_owned_tree,
    reserve_cache,
    runtime_root,
    shared_cache_paths,
    steer_event_name,
    terminate_process_tree,
    validate_route,
)


def git(source: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(source), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or f"git {' '.join(args)} failed")
    return completed.stdout.strip()


def git_input(source: Path, args: list[str], content: bytes) -> None:
    completed = subprocess.run(
        ["git", "-C", str(source), *args],
        input=content,
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode("utf-8", errors="replace").strip() or "git apply failed")


def prepare_snapshot_baseline(
    source: Path,
    worktree: Path,
    source_head: str,
    snapshot: SourceSnapshot,
    evidence_files: list[Path],
) -> tuple[str, dict[str, object] | None]:
    tracked_patch = snapshot["trackedPatch"]
    if tracked_patch:
        git_input(worktree, ["apply", "--binary", "--whitespace=nowarn", "-"], tracked_patch)
    for item in snapshot["untracked"]:
        relative = str(item["path"])
        source_file = source / relative
        target = worktree / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]:
            raise RuntimeError(f"source changed while copying untracked file: {relative}")

    copied = capture_source_snapshot(worktree)
    if copied["fingerprint"] != snapshot["fingerprint"]:
        raise RuntimeError("isolated worktree does not match the captured source WIP")
    if capture_source_snapshot(source)["fingerprint"] != snapshot["fingerprint"]:
        raise RuntimeError("source checkout changed while creating the isolated WIP snapshot")

    manifest: dict[str, object] | None = None
    if evidence_files:
        input_dir = worktree / ".pi-worker-inputs"
        input_dir.mkdir()
        entries: list[dict[str, str]] = []
        for index, supplied in enumerate(evidence_files, 1):
            source_file = supplied.resolve()
            mode = source_file.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise RuntimeError(f"evidence input is not a regular file: {source_file}")
            target = input_dir / f"{index:03d}-{source_file.name}"
            before = hashlib.sha256(source_file.read_bytes()).hexdigest()
            shutil.copy2(source_file, target)
            if hashlib.sha256(target.read_bytes()).hexdigest() != before:
                raise RuntimeError(f"evidence input changed while copying: {source_file}")
            entries.append({"source": str(source_file), "copy": target.relative_to(worktree).as_posix()})
        manifest = {"files": entries}
        atomic_json(input_dir / "manifest.json", manifest)

    if not snapshot["dirty"] and not evidence_files:
        return source_head, None
    git(worktree, "add", "-A")
    tree = git(worktree, "write-tree")
    baseline = git(
        worktree,
        "-c",
        "user.name=Pi Worker Snapshot",
        "-c",
        "user.email=pi-worker@local.invalid",
        "commit-tree",
        tree,
        "-p",
        source_head,
        "-m",
        "pi-worker: captured source WIP baseline",
    )
    git(worktree, "reset", "--hard", baseline)
    return baseline, manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", type=Path, required=True)
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
    parser.add_argument("--evidence-file", type=Path, action="append", default=[])
    args = parser.parse_args()
    if args.evidence_file and args.mode != "implementation":
        raise SystemExit("--evidence-file requires implementation mode")

    output_dir = args.output_dir.resolve()
    receipt_path = output_dir / "pi-receipt.json"
    result_path = output_dir / "pi-result.json"
    if receipt_path.exists() or result_path.exists():
        raise SystemExit(f"output directory already contains a run: {output_dir}")
    started = time.perf_counter()
    run_id = str(uuid.uuid4())
    session_id = run_id
    source_cwd = args.cwd.resolve()
    if not source_cwd.is_dir():
        raise SystemExit(f"cwd is not a directory: {source_cwd}")
    root = runtime_root()
    root.mkdir(parents=True, exist_ok=True)
    reconciliation = reconcile_jobs(root)
    validate_route(args.provider, args.model)
    session_dir = (root / "sessions" / run_id).resolve()
    steer_queue_dir = (root / "runs" / run_id / "steer").resolve()
    cache_roots = shared_cache_paths(root)
    worktree_path: Path | None = None
    execution_cwd = source_cwd
    source_root = source_cwd
    base_commit = ""
    source_head = ""
    source_snapshot: SourceSnapshot | None = None
    input_manifest: dict[str, object] | None = None
    if args.mode == "implementation":
        source_root = Path(git(source_cwd, "rev-parse", "--show-toplevel")).resolve()
        if git(source_root, "diff", "--name-only", "--diff-filter=U"):
            raise SystemExit("implementation mode cannot snapshot unresolved merge conflicts")
        if "-dirty" in git(source_root, "diff", "--submodule=short", "HEAD"):
            raise SystemExit("implementation mode cannot snapshot dirty submodules")
        source_head = git(source_root, "rev-parse", "HEAD")
        source_snapshot = capture_source_snapshot(source_root)
        base_commit = source_head
        worktree_path = (root / "worktrees" / run_id[:12]).resolve()
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        if worktree_path.exists():
            raise SystemExit(f"worktree path already exists: {worktree_path}")
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_status = reserve_cache(root, run_id)
    if worktree_path is not None:
        try:
            git(source_root, "worktree", "add", "--detach", str(worktree_path), source_head)
            execution_cwd = worktree_path / source_cwd.relative_to(source_root)
            assert source_snapshot is not None
            base_commit, input_manifest = prepare_snapshot_baseline(
                source_root,
                worktree_path,
                source_head,
                source_snapshot,
                args.evidence_file,
            )
        except BaseException:
            subprocess.run(
                ["git", "-C", str(source_root), "worktree", "remove", "--force", str(worktree_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                check=False,
            )
            if worktree_path.is_dir():
                try:
                    remove_owned_tree(worktree_path, root / "worktrees")
                except (OSError, ValueError):
                    pass
            release_cache(root, run_id)
            raise
    try:
        session_dir.mkdir(parents=True, exist_ok=False)
    except BaseException:
        try:
            if worktree_path is not None:
                git(source_root, "worktree", "remove", "--force", str(worktree_path))
        finally:
            release_cache(root, run_id)
        raise

    def rollback(process: subprocess.Popen[bytes] | None = None) -> None:
        if process is not None:
            terminate_process_tree(process)
        if worktree_path is not None:
            subprocess.run(
                ["git", "-C", str(source_root), "worktree", "remove", "--force", str(worktree_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                check=False,
            )
            if worktree_path.is_dir():
                try:
                    remove_owned_tree(worktree_path, root / "worktrees")
                except (OSError, ValueError):
                    pass
        if session_dir.is_dir():
            try:
                remove_owned_tree(session_dir, root / "sessions")
            except (OSError, ValueError):
                pass
        release_cache(root, run_id)
        remove_job(root, run_id)
        receipt_path.unlink(missing_ok=True)
        result_path.unlink(missing_ok=True)

    try:
        record_job(
            root,
            run_id,
            state="starting",
            pid=0,
            latestRunId=run_id,
            resultPath=str(result_path),
            ownerReceiptPath=str(receipt_path),
            sourceRoot=str(source_root),
            worktreePath=str(worktree_path) if worktree_path else None,
            sessionDir=str(session_dir),
            outputDir=str(output_dir),
        )
    except BaseException:
        rollback()
        raise
    runner = Path(__file__).with_name("run_pi_worker.py")
    command = [
        sys.executable,
        str(runner),
        "--cwd",
        str(execution_cwd),
        "--source-cwd",
        str(source_cwd),
        "--source-root",
        str(source_root),
        "--prompt-file",
        str(args.prompt_file.resolve()),
        "--mode",
        args.mode,
        "--output-dir",
        str(output_dir),
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--provider",
        args.provider,
        "--model",
        args.model,
        "--thinking",
        args.thinking,
        "--run-id",
        run_id,
        "--runtime-root",
        str(root),
        "--base-commit",
        base_commit,
        "--source-fingerprint",
        str(source_snapshot["fingerprint"] if source_snapshot else ""),
        "--session-id",
        session_id,
        "--session-dir",
        str(session_dir),
        "--owner-run-id",
        run_id,
        "--turn-index",
        "1",
        "--attention-event-name",
        attention_event_name(run_id),
        "--cancel-event-name",
        cancel_event_name(run_id),
        "--steer-event-name",
        steer_event_name(run_id),
        "--steer-queue-dir",
        str(steer_queue_dir),
        "--launch-gated",
    ]
    if worktree_path is not None:
        command.extend(("--worktree-path", str(worktree_path)))
    if input_manifest is not None:
        command.extend(("--input-manifest", ".pi-worker-inputs/manifest.json"))
    if args.context_mode:
        command.append("--context-mode")
    if args.firecrawl:
        command.append("--firecrawl")
    if args.playwright:
        command.append("--playwright")

    stdout_file = (output_dir / "runtime.stdout.log").open("wb")
    stderr_file = (output_dir / "runtime.stderr.log").open("wb")
    flags = (
        subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        if os.name == "nt"
        else 0
    )
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
        rollback()
        raise
    finally:
        stdout_file.close()
        stderr_file.close()
    receipt = {
        "runId": run_id,
        "pid": process.pid,
        "status": "running",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "receiptLatencySeconds": round(time.perf_counter() - started, 3),
        "resultPath": str(result_path),
        "attentionPath": str(output_dir / "pi-attention.json"),
        "attentionEventName": attention_event_name(run_id),
        "cancelEventName": cancel_event_name(run_id),
        "steerEventName": steer_event_name(run_id),
        "steerQueueDir": str(steer_queue_dir),
        "steerAvailable": os.name == "nt",
        "outputDir": str(output_dir),
        "sourceRoot": str(source_root),
        "sourceCwd": str(source_cwd),
        "executionCwd": str(execution_cwd),
        "worktreePath": str(worktree_path) if worktree_path else None,
        "baseCommit": base_commit or None,
        "sourceHead": source_head or None,
        "sourceSnapshot": (
            {
                "fingerprint": source_snapshot["fingerprint"],
                "dirty": source_snapshot["dirty"],
                "trackedPatchSha256": source_snapshot["trackedPatchSha256"],
                "untrackedFiles": len(source_snapshot["untracked"]),
                "untrackedBytes": sum(int(item["bytes"]) for item in source_snapshot["untracked"]),
            }
            if source_snapshot
            else None
        ),
        "inputManifest": input_manifest,
        "sessionId": session_id,
        "sessionDir": str(session_dir),
        "turnIndex": 1,
        "ownerReceiptPath": str(receipt_path),
        "latestReceiptPath": str(receipt_path),
        "lastTurnIndex": 1,
        "mode": args.mode,
        "provider": args.provider,
        "model": args.model,
        "thinking": args.thinking,
        "timeoutSeconds": args.timeout_seconds,
        "cleanupStatus": "pending_worker",
        "cacheRoots": {name: str(path) for name, path in cache_roots.items()},
        "cacheLimitBytes": 20 * 1024**3,
        "cacheStatusAtStart": cache_status,
        "contextMode": args.context_mode,
        "firecrawl": args.firecrawl,
        "playwright": args.playwright,
        "runtimeRoot": str(root),
        "runtimeReconciliation": reconciliation,
        "nextAction": "watch",
    }
    try:
        activate_cache(root, run_id, process.pid)
        atomic_json(receipt_path, receipt)
        record_job(
            root,
            run_id,
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
        rollback(process)
        raise
    emit_json(receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
