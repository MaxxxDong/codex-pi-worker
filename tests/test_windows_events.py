from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import start_pi_worker  # noqa: E402
from prepare_pi_playwright_windows import NEW, OLD, patch_runtime  # noqa: E402
from run_pi_worker import (  # noqa: E402
    MAX_FINAL_TEXT_BYTES,
    MAX_TOOL_ERROR_BYTES,
    classify_attention,
    cleanup_run_temp,
    compact_event,
    git_changes,
    parse_events,
    redact_credentials,
    write_patch,
    write_runner_failure,
)
from runtime_support import (  # noqa: E402
    atomic_json,
    attention_event_name,
    capture_source_snapshot,
    close_windows_handle,
    create_attention_event,
    emit_json,
    managed_cache_paths,
    pid_alive,
    reconcile_jobs,
    record_job,
    remove_owned_tree,
    remove_run_temp,
    set_attention_event,
    worker_environment,
)


class WindowsEventTests(unittest.TestCase):
    def test_dirty_source_snapshot_preserves_wip_and_patch_contains_only_worker_delta(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            worktree = root / "worktree"
            output = root / "output"
            source.mkdir()
            output.mkdir()
            for command in (
                ["git", "init", str(source)],
                ["git", "-C", str(source), "config", "user.email", "pi-test@example.invalid"],
                ["git", "-C", str(source), "config", "user.name", "Pi Test"],
            ):
                subprocess.run(command, check=True, capture_output=True)
            (source / ".gitignore").write_text(".venv/\n", encoding="utf-8")
            (source / "tracked.txt").write_text("base\n", encoding="utf-8")
            (source / "untouched.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(["git", "-C", str(source), "commit", "-m", "base"], check=True, capture_output=True)

            (source / "tracked.txt").write_text("base\nwip\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "tracked.txt"], check=True)
            (source / "tracked.txt").write_text("base\nwip\nunstaged\n", encoding="utf-8")
            (source / "untouched.txt").write_text("base\nuser-only\n", encoding="utf-8")
            (source / "new.txt").write_text("untracked WIP\n", encoding="utf-8")
            (source / ".venv").mkdir()
            (source / ".venv" / "ignored.txt").write_text("ignored\n", encoding="utf-8")
            evidence = root / "evidence.json"
            evidence.write_text('{"ok":true}\n', encoding="utf-8")

            before = capture_source_snapshot(source)
            source_head = start_pi_worker.git(source, "rev-parse", "HEAD")
            start_pi_worker.git(source, "worktree", "add", "--detach", str(worktree), source_head)
            try:
                baseline, manifest = start_pi_worker.prepare_snapshot_baseline(
                    source,
                    worktree,
                    source_head,
                    before,
                    [evidence],
                )
                self.assertNotEqual(baseline, source_head)
                self.assertEqual(capture_source_snapshot(source)["fingerprint"], before["fingerprint"])
                self.assertEqual(subprocess.run(
                    ["git", "-C", str(worktree), "status", "--porcelain"],
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout, "")
                self.assertEqual((worktree / "tracked.txt").read_text(encoding="utf-8"), "base\nwip\nunstaged\n")
                self.assertEqual((worktree / "new.txt").read_text(encoding="utf-8"), "untracked WIP\n")
                self.assertFalse((worktree / ".venv").exists())
                assert manifest is not None
                self.assertEqual(manifest["files"][0]["copy"], ".pi-worker-inputs/001-evidence.json")

                (worktree / "tracked.txt").write_text("base\nwip\nunstaged\nworker\n", encoding="utf-8")
                (worktree / "worker.txt").write_text("worker\n", encoding="utf-8")
                patch_info = write_patch(worktree, output, baseline)
                self.assertIsNotNone(patch_info)
                assert patch_info is not None
                self.assertEqual(set(patch_info["files"]), {"tracked.txt", "worker.txt"})
                subprocess.run(
                    ["git", "-C", str(source), "apply", "--whitespace=nowarn", str(output / "changes.patch")],
                    check=True,
                    capture_output=True,
                )
                self.assertEqual((source / "tracked.txt").read_text(encoding="utf-8"), "base\nwip\nunstaged\nworker\n")
                self.assertEqual((source / "untouched.txt").read_text(encoding="utf-8"), "base\nuser-only\n")
            finally:
                subprocess.run(
                    ["git", "-C", str(source), "worktree", "remove", "--force", str(worktree)],
                    capture_output=True,
                    check=False,
                )

    @unittest.skipUnless(os.name == "nt", "Windows integration test")
    def test_start_rejects_source_drift_and_rolls_back_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            output = root / "output"
            runtime = root / "runtime"
            source.mkdir()
            for command in (
                ["git", "init", str(source)],
                ["git", "-C", str(source), "config", "user.email", "pi-test@example.invalid"],
                ["git", "-C", str(source), "config", "user.name", "Pi Test"],
            ):
                subprocess.run(command, check=True, capture_output=True)
            tracked = source / "tracked.txt"
            tracked.write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "tracked.txt"], check=True)
            subprocess.run(["git", "-C", str(source), "commit", "-m", "base"], check=True, capture_output=True)
            tracked.write_text("base\nwip\n", encoding="utf-8")
            prompt = root / "task.md"
            prompt.write_text("test", encoding="utf-8")

            real_capture = capture_source_snapshot
            capture_count = 0

            def capture_with_drift(path: Path):
                nonlocal capture_count
                capture_count += 1
                if capture_count == 3:
                    tracked.write_text("base\nwip\nconcurrent edit\n", encoding="utf-8")
                return real_capture(path)

            argv = [
                "start_pi_worker.py",
                "--cwd",
                str(source),
                "--prompt-file",
                str(prompt),
                "--output-dir",
                str(output),
            ]
            env = {
                "PI_WORKER_ROOT": str(runtime),
                "LOCALAPPDATA": str(root / "local"),
                "PI_WORKER_DISABLE_CACHE_GC": "1",
            }
            with (
                patch.dict(os.environ, env),
                patch.object(sys, "argv", argv),
                patch.object(start_pi_worker, "capture_source_snapshot", side_effect=capture_with_drift),
                self.assertRaisesRegex(RuntimeError, "source checkout changed"),
            ):
                start_pi_worker.main()

            self.assertFalse((output / "pi-receipt.json").exists())
            self.assertFalse(any((runtime / "worktrees").glob("*")))
            self.assertFalse(any((runtime / "active").glob("*.json")))
            self.assertFalse(any((runtime / "jobs").glob("*.json")))
            registrations = source / ".git" / "worktrees"
            self.assertFalse(registrations.exists() and any(registrations.iterdir()))

    def test_playwright_windows_patch_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime.js"
            backup = root / "backup.js"
            runtime.write_text(OLD, encoding="utf-8")
            self.assertTrue(patch_runtime(runtime, backup))
            self.assertFalse(patch_runtime(runtime, backup))
            self.assertIn(NEW, runtime.read_text(encoding="utf-8"))
            self.assertEqual(backup.read_text(encoding="utf-8"), OLD)

    def test_atomic_json_supports_concurrent_writers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            with ThreadPoolExecutor(max_workers=12) as pool:
                list(pool.map(lambda value: atomic_json(path, {"value": value}), range(100)))
            self.assertIn(json.loads(path.read_text(encoding="utf-8"))["value"], range(100))
            self.assertEqual(list(path.parent.glob(f".{path.name}.*.tmp")), [])

    def test_terminal_job_is_not_downgraded_to_orphaned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = root / "result.json"
            current = record_job(
                root,
                "job",
                state="pending_review",
                pid=0,
                latestRunId="turn",
                resultPath=str(result),
            )
            preserved = record_job(
                root,
                "job",
                state="orphaned",
                pid=0,
                latestRunId="turn",
                resultPath=str(root / "missing.json"),
            )
            self.assertEqual(preserved, current)
            self.assertEqual(preserved["state"], "pending_review")
            self.assertEqual(preserved["resultPath"], str(result))

    @unittest.skipUnless(os.name == "nt", "Windows extended-length path behavior")
    def test_remove_owned_tree_handles_extended_length_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "owned"
            target.mkdir()
            deep = target
            while len(str(deep / "payload.txt")) <= 300:
                deep /= "nested-segment-0123456789"
            extended = "\\\\?\\" + str(deep)
            os.makedirs(extended)
            with open(extended + "\\payload.txt", "w", encoding="utf-8") as handle:
                handle.write("payload")

            remove_owned_tree(target, root)

            self.assertFalse(target.exists())

    def test_remove_run_temp_retries_transient_windows_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "runs" / "locked"
            run_dir.mkdir(parents=True)
            with (
                patch("runtime_support.os.name", "nt"),
                patch("runtime_support.remove_owned_tree", side_effect=[PermissionError(5, "locked"), None]) as remove,
                patch("runtime_support.time.sleep") as sleep,
            ):
                remove_run_temp(root, "locked")
            self.assertEqual(remove.call_count, 2)
            sleep.assert_called_once_with(0.1)

    def test_locked_run_temp_is_deferred_without_runner_failure(self) -> None:
        error = PermissionError(5, "locked JNA DLL")
        with patch("run_pi_worker.remove_run_temp", side_effect=error):
            status = cleanup_run_temp(Path("runtime"), "run")
        self.assertEqual(status["status"], "deferred")
        self.assertIn("locked JNA DLL", status["error"])

    def test_compact_tool_start_is_timestamped(self) -> None:
        event = json.loads(compact_event(b'{"type":"tool_execution_start","toolName":"read"}\n'))
        self.assertEqual(event["toolName"], "read")
        self.assertIn("at", event)

    def test_compact_tool_error_keeps_bounded_redacted_summary(self) -> None:
        raw = json.dumps(
            {
                "type": "tool_execution_end",
                "toolName": "read",
                "isError": True,
                "result": {"content": [{"type": "text", "text": "sk-1234567890 " + "x" * 4096}]},
            }
        ).encode()
        event = json.loads(compact_event(raw))
        self.assertNotIn("sk-1234567890", event["errorSummary"])
        self.assertIn("[REDACTED]", event["errorSummary"])
        self.assertLessEqual(len(event["errorSummary"].encode()), MAX_TOOL_ERROR_BYTES)

    def test_generated_tool_artifacts_are_excluded_from_patch_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            root = temporary_root / "repo"
            root.mkdir()
            subprocess.run(["git", "init"], cwd=root, capture_output=True, check=True)
            (root / "tracked.txt").write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=root, capture_output=True, check=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "base"],
                cwd=root,
                capture_output=True,
                check=True,
            )
            base = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True
            ).stdout.strip()
            (root / "tracked.txt").write_text("after\n", encoding="utf-8")
            (root / ".playwright-cli").mkdir()
            (root / ".playwright-cli" / "page.yml").write_text("generated", encoding="utf-8")
            (root / "__pycache__").mkdir()
            (root / "__pycache__" / "x.pyc").write_bytes(b"generated")
            output = temporary_root / "evidence"
            output.mkdir()
            patch = write_patch(root, output, base)
            self.assertIsNotNone(patch)
            patch_text = (output / "changes.patch").read_text(encoding="utf-8")
            self.assertIn("tracked.txt", patch_text)
            self.assertNotIn("playwright", patch_text)
            self.assertNotIn("pycache", patch_text)
            self.assertEqual(patch["files"], ["tracked.txt"])
            self.assertEqual(git_changes(root), [" M tracked.txt"])

    def test_compact_message_caps_repeated_stream_text(self) -> None:
        text = "x" * (MAX_FINAL_TEXT_BYTES + 1024)
        raw = json.dumps(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "provider": "opencode-go",
                    "model": "deepseek-v4-flash",
                    "stopReason": "stop",
                    "content": [{"type": "text", "text": text}],
                },
            }
        ).encode()
        event = json.loads(compact_event(raw))
        message = event["message"]
        self.assertTrue(message["contentTruncated"])
        self.assertLessEqual(len(message["content"][0]["text"].encode()), MAX_FINAL_TEXT_BYTES)

    def test_json_stdout_is_cp936_safe(self) -> None:
        output = io.StringIO()
        with patch("sys.stdout", output):
            emit_json({"text": "A ↔ B − C"})
        encoded = output.getvalue().encode("cp936")
        self.assertIn(b"\\u2194", encoded)
        self.assertEqual(json.loads(encoded.decode("cp936"))["text"], "A ↔ B − C")

    def test_attention_categories_are_specific(self) -> None:
        self.assertEqual(classify_attention("Error: EPIPE: broken pipe"), "broken_pipe")
        self.assertEqual(classify_attention("HTTP 429 rate limit"), "provider_rate_limit")
        self.assertIsNone(classify_attention("9 tests passed"))
        self.assertIsNone(classify_attention("at module.py line 500"))

    def test_worker_environment_keeps_toolchains_but_drops_unrelated_secrets(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.dict(
                os.environ,
                {
                    "JAVA_HOME": r"C:\Java",
                    "EXA_API_KEY": "web-key",
                    "FIRECRAWL_API_KEY": "crawl-key",
                    "TAVILY_API_KEY": "search-key",
                    "UNRELATED_SECRET": "do-not-pass",
                },
            ),
        ):
            env, _ = worker_environment(Path(temporary), "safe-env")
        self.assertEqual(env["JAVA_HOME"], r"C:\Java")
        self.assertEqual(env["EXA_API_KEY"], "web-key")
        self.assertEqual(env["FIRECRAWL_API_KEY"], "crawl-key")
        self.assertEqual(env["TAVILY_API_KEY"], "search-key")
        self.assertNotIn("UNRELATED_SECRET", env)

    def test_cache_defaults_are_runtime_owned_and_metadata_cannot_redirect_gc(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.dict(
                os.environ,
                {"UV_CACHE_DIR": "", "PIP_CACHE_DIR": "", "npm_config_cache": ""},
                clear=False,
            ),
        ):
            for name in ("UV_CACHE_DIR", "PIP_CACHE_DIR", "npm_config_cache"):
                os.environ.pop(name, None)
            root = Path(temporary) / "runtime"
            expected = {name: (root / "cache" / name).resolve() for name in ("uv", "pip", "npm")}
            self.assertEqual(managed_cache_paths(root), expected)
            outside = Path(temporary) / "outside"
            outside.mkdir()
            atomic_json(root / "cache-roots.json", {"uv": str(outside)})
            self.assertEqual(managed_cache_paths(root), expected)

    def test_cache_explicit_environment_overrides_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "runtime"
            explicit = Path(temporary) / "explicit"
            with patch.dict(
                os.environ,
                {
                    "UV_CACHE_DIR": str(explicit / "uv"),
                    "PIP_CACHE_DIR": str(explicit / "pip"),
                    "npm_config_cache": str(explicit / "npm"),
                },
            ):
                paths = managed_cache_paths(root)
            self.assertEqual(paths, {name: (explicit / name).resolve() for name in ("uv", "pip", "npm")})

    def test_stderr_credentials_are_redacted(self) -> None:
        raw = b"Authorization: Bearer secret-value\nBearer abcdefghijklmnop sk-1234567890 nb_abcdefghij\n"
        redacted = redact_credentials(raw)
        self.assertNotIn(b"secret-value", redacted)
        self.assertNotIn(b"abcdefghijklmnop", redacted)
        self.assertNotIn(b"sk-1234567890", redacted)
        self.assertNotIn(b"nb-abcdefghij", redacted)
        self.assertEqual(redacted.count(b"[REDACTED]"), 4)

    def test_final_text_truncation_is_preserved_by_event_parser(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = Path(temporary) / "events.jsonl"
            events.write_bytes(
                compact_event(
                    json.dumps(
                        {
                            "type": "message_end",
                            "message": {
                                "role": "assistant",
                                "content": [{"type": "text", "text": "x" * (MAX_FINAL_TEXT_BYTES + 1)}],
                            },
                        }
                    ).encode()
                )
            )
            self.assertTrue(parse_events(events)["finalTextTruncated"])

    def test_dead_job_is_reconciled_without_deleting_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = root / "result.json"
            result.write_text("{}", encoding="utf-8")
            stale_run = root / "runs" / "stale"
            stale_run.mkdir(parents=True)
            (stale_run / "tmp.txt").write_text("stale", encoding="utf-8")
            os.utime(stale_run, (0, 0))
            (root / "worktrees" / "legacy").mkdir(parents=True)
            record_job(root, "dead", state="running", pid=999999, resultPath=str(result))
            status = reconcile_jobs(root)
            job = json.loads((root / "jobs" / "dead.json").read_text(encoding="utf-8"))
            self.assertEqual(status["pendingReview"], 1)
            self.assertEqual(job["state"], "pending_review")
            self.assertTrue(result.is_file())
            self.assertEqual(status["runDirsRemoved"], 1)
            self.assertFalse(stale_run.exists())
            self.assertEqual(status["untrackedWorktrees"], 1)

    def test_old_receipt_terminal_json_is_cp936_safe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result_path = root / "pi-result.json"
            receipt_path = root / "pi-receipt.json"
            atomic_json(result_path, {"status": "completed", "finalText": "A ↔ B − C"})
            atomic_json(receipt_path, {"runId": "old", "pid": os.getpid(), "resultPath": str(result_path)})
            completed = subprocess.run(
                [sys.executable, str(SCRIPTS / "watch_pi_worker.py"), str(receipt_path), "--timeout-seconds", "1"],
                capture_output=True,
                text=True,
                encoding="cp936",
                env={**os.environ, "PYTHONIOENCODING": "cp936"},
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["result"]["finalText"], "A ↔ B − C")

    def test_runner_exception_writes_structured_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = SimpleNamespace(
                output_dir=root / "output",
                run_id="failed-run",
                mode="analysis",
                provider="krill",
                model="grok-4.5",
                thinking="high",
                worktree_path=None,
                runtime_root=root / "runtime",
                session_id="failed-session",
                session_dir=root / "runtime" / "sessions" / "failed-session",
                turn_index=1,
            )
            stdout = io.StringIO()
            stderr = io.StringIO()
            with patch("sys.stdout", stdout), patch("sys.stderr", stderr):
                code = write_runner_failure(args, RuntimeError("failed ↔ safely"))
            result = json.loads((args.output_dir / "pi-result.json").read_text(encoding="utf-8"))
            self.assertEqual(code, 1)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["stopReason"], "runner_error")
            stdout.getvalue().encode("cp936")

    def test_runner_system_exit_writes_failure_and_releases_runtime_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            output = root / "output"
            source = root / "source"
            source.mkdir()
            prompt = root / "prompt.md"
            prompt.write_text("test", encoding="utf-8")
            run_id = "preflight-failure"
            atomic_json(runtime / "active" / f"{run_id}.json", {"runId": run_id, "pid": os.getpid()})
            (runtime / "runs" / run_id / "tmp").mkdir(parents=True)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "run_pi_worker.py"),
                    "--cwd",
                    str(source),
                    "--source-cwd",
                    str(source),
                    "--prompt-file",
                    str(prompt),
                    "--mode",
                    "analysis",
                    "--output-dir",
                    str(output),
                    "--runtime-root",
                    str(runtime),
                    "--run-id",
                    run_id,
                    "--session-id",
                    "session",
                    "--session-dir",
                    str(runtime / "sessions" / "session"),
                    "--provider",
                    "krill",
                    "--model",
                    "gpt-5.6-luna",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            result = json.loads((output / "pi-result.json").read_text(encoding="utf-8"))
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["runnerError"]["type"], "SystemExit")
            self.assertFalse((runtime / "active" / f"{run_id}.json").exists())
            self.assertFalse((runtime / "runs" / run_id).exists())

    @unittest.skipUnless(os.name == "nt", "Windows integration test")
    def test_watch_reports_dead_runner_as_structured_orphan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            output = root / "output"
            output.mkdir()
            run_id = "dead-turn"
            receipt = output / "pi-receipt.json"
            result = output / "pi-result.json"
            atomic_json(
                receipt,
                {
                    "runId": run_id,
                    "pid": 2_000_000_000,
                    "resultPath": str(result),
                    "outputDir": str(output),
                    "runtimeRoot": str(runtime),
                },
            )
            atomic_json(
                runtime / "jobs" / f"{run_id}.json",
                {"jobId": run_id, "state": "running", "pid": 2_000_000_000, "resultPath": str(result)},
            )
            atomic_json(runtime / "active" / f"{run_id}.json", {"runId": run_id, "pid": 2_000_000_000})

            watched = subprocess.run(
                [sys.executable, str(SCRIPTS / "watch_pi_worker.py"), str(receipt), "--timeout-seconds", "1"],
                capture_output=True,
                text=True,
                encoding="cp936",
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )

            self.assertEqual(watched.returncode, 0, watched.stderr)
            orphan = json.loads(watched.stdout)
            self.assertEqual(orphan["event"], "orphaned")
            self.assertEqual(orphan["lifecycleState"], "orphaned")
            job = json.loads((runtime / "jobs" / f"{run_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(job["state"], "orphaned")
            self.assertFalse((runtime / "active" / f"{run_id}.json").exists())

    @unittest.skipUnless(os.name == "nt", "Windows integration test")
    def test_receipt_bound_cancel_preserves_review_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            source = root / "source"
            output = root / "output"
            fake_bin.mkdir()
            source.mkdir()
            prompt = root / "task.md"
            prompt.write_text("test", encoding="utf-8")
            fake = fake_bin / "fake_pi.py"
            fake.write_text("import time; time.sleep(30)\n", encoding="utf-8")
            (fake_bin / "pi.cmd").write_text(
                f'@echo off\r\n"{sys.executable}" "{fake}" %*\r\n',
                encoding="utf-8",
            )
            runtime = root / "runtime"
            env = {
                **os.environ,
                "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                "PI_WORKER_ROOT": str(runtime),
                "PI_WORKER_DISABLE_CACHE_GC": "1",
                "PYTHONIOENCODING": "utf-8",
            }
            started = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "start_pi_worker.py"),
                    "--cwd",
                    str(source),
                    "--prompt-file",
                    str(prompt),
                    "--mode",
                    "analysis",
                    "--output-dir",
                    str(output),
                    "--timeout-seconds",
                    "30",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(started.returncode, 0, started.stderr)

            cancelled = subprocess.run(
                [sys.executable, str(SCRIPTS / "cancel_pi_worker.py"), str(output / "pi-receipt.json")],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(cancelled.returncode, 0, cancelled.stderr)
            self.assertEqual(json.loads(cancelled.stdout)["event"], "cancel_requested")

            watched = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "watch_pi_worker.py"),
                    str(output / "pi-receipt.json"),
                    "--timeout-seconds",
                    "10",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(watched.returncode, 0, watched.stderr)
            terminal = json.loads(watched.stdout)
            self.assertEqual(terminal["event"], "terminal")
            self.assertEqual(terminal["result"]["status"], "cancelled")
            self.assertEqual(terminal["result"]["stopReason"], "cancelled")
            self.assertEqual(terminal["lifecycleState"], "pending_review")
            self.assertTrue((output / "pi-result.json").is_file())
            self.assertTrue(Path(terminal["result"]["sessionDir"]).is_dir())
            self.assertFalse((runtime / "active" / f"{terminal['result']['runId']}.json").exists())

    @unittest.skipUnless(os.name == "nt", "Windows integration test")
    def test_start_rolls_back_when_receipt_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            source = root / "source"
            output = root / "output"
            fake_bin.mkdir()
            source.mkdir()
            prompt = root / "task.md"
            prompt.write_text("test", encoding="utf-8")
            fake = fake_bin / "fake_pi.py"
            fake.write_text("import time; time.sleep(30)\n", encoding="utf-8")
            (fake_bin / "pi.cmd").write_text(
                f'@echo off\r\n"{sys.executable}" "{fake}" %*\r\n',
                encoding="utf-8",
            )
            runtime = root / "runtime"
            argv = [
                "start_pi_worker.py",
                "--cwd",
                str(source),
                "--prompt-file",
                str(prompt),
                "--mode",
                "analysis",
                "--output-dir",
                str(output),
            ]
            env = {
                "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                "PI_WORKER_ROOT": str(runtime),
                "LOCALAPPDATA": str(root / "local"),
                "PI_WORKER_DISABLE_CACHE_GC": "1",
            }
            with (
                patch.dict(os.environ, env),
                patch.object(sys, "argv", argv),
                patch.object(start_pi_worker, "atomic_json", side_effect=OSError("receipt failed")),
                self.assertRaisesRegex(OSError, "receipt failed"),
            ):
                start_pi_worker.main()
            self.assertFalse(any((runtime / "sessions").iterdir()))
            self.assertFalse(any((runtime / "jobs").glob("*.json")))
            self.assertFalse(any((runtime / "active").glob("*.json")))

    @unittest.skipUnless(os.name == "nt", "Windows event test")
    def test_multi_receipt_watch_returns_first_attention_without_waiting_for_others(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            attention_path = root / "pi-attention.json"
            receipt_path = root / "pi-receipt.json"
            other_receipt_path = root / "other-receipt.json"
            run_id = "test-attention"
            event_name = attention_event_name(run_id)
            sleeper = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            other_sleeper = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            handle = create_attention_event(event_name)
            try:
                atomic_json(
                    receipt_path,
                    {
                        "runId": run_id,
                        "pid": sleeper.pid,
                        "resultPath": str(root / "pi-result.json"),
                        "attentionPath": str(attention_path),
                        "attentionEventName": event_name,
                    },
                )
                atomic_json(
                    other_receipt_path,
                    {
                        "runId": "still-running",
                        "pid": other_sleeper.pid,
                        "resultPath": str(root / "other-result.json"),
                    },
                )
                watcher = subprocess.Popen(
                    [
                        sys.executable,
                        str(SCRIPTS / "watch_pi_worker.py"),
                        str(other_receipt_path),
                        str(receipt_path),
                        "--timeout-seconds",
                        "5",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="cp936",
                    env={**os.environ, "PYTHONIOENCODING": "cp936"},
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                time.sleep(0.2)
                atomic_json(attention_path, {"runId": run_id, "category": "broken_pipe", "text": "↔"})
                started = time.perf_counter()
                set_attention_event(handle)
                stdout, stderr = watcher.communicate(timeout=3)
                self.assertEqual(watcher.returncode, 0, stderr)
                self.assertLess(time.perf_counter() - started, 1.0)
                event = json.loads(stdout)
                self.assertEqual(event["event"], "attention")
                self.assertTrue(Path(event["receipt"]).samefile(receipt_path))
                self.assertIsNone(other_sleeper.poll())
                self.assertTrue((root / "pi-attention-delivered-001.json").is_file())
            finally:
                close_windows_handle(handle)
                sleeper.terminate()
                sleeper.wait(timeout=5)
                other_sleeper.terminate()
                other_sleeper.wait(timeout=5)

    @unittest.skipUnless(os.name == "nt", "Windows integration test")
    def test_runner_stderr_attention_arrives_before_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            source = root / "source"
            output = root / "output"
            fake_bin.mkdir()
            source.mkdir()
            prompt = root / "task.md"
            prompt.write_text("test", encoding="utf-8")
            fake = fake_bin / "fake_pi.py"
            fake.write_text(
                "import sys, time\n"
                "sys.stderr.write('Error: EPIPE: broken pipe\\n')\n"
                "sys.stderr.flush()\n"
                "time.sleep(2)\n",
                encoding="utf-8",
            )
            (fake_bin / "pi.cmd").write_text(
                f'@echo off\r\n"{sys.executable}" "{fake}" %*\r\n',
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                "PI_WORKER_ROOT": str(root / "runtime"),
                "PI_WORKER_DISABLE_CACHE_GC": "1",
                "PYTHONIOENCODING": "cp936",
            }
            started = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "start_pi_worker.py"),
                    "--cwd",
                    str(source),
                    "--prompt-file",
                    str(prompt),
                    "--mode",
                    "analysis",
                    "--output-dir",
                    str(output),
                    "--provider",
                    "krill",
                    "--model",
                    "grok-4.5",
                    "--thinking",
                    "high",
                    "--timeout-seconds",
                    "10",
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(started.returncode, 0, started.stderr)
            receipt = json.loads(started.stdout)
            before = time.perf_counter()
            watched = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "watch_pi_worker.py"),
                    str(output / "pi-receipt.json"),
                    "--timeout-seconds",
                    "5",
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(watched.returncode, 0, watched.stderr)
            self.assertLess(time.perf_counter() - before, 1.5)
            self.assertEqual(json.loads(watched.stdout)["event"], "attention")
            self.assertTrue(pid_alive(receipt["pid"]), "attention must arrive before terminal")
            deadline = time.time() + 5
            while time.time() < deadline and not (output / "pi-result.json").is_file():
                time.sleep(0.05)
            self.assertTrue((output / "pi-result.json").is_file())

    @unittest.skipUnless(os.name == "nt", "Windows integration test")
    def test_timeout_is_renewed_by_productive_events(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            source = root / "source"
            output = root / "output"
            fake_bin.mkdir()
            source.mkdir()
            prompt = root / "task.md"
            prompt.write_text("test", encoding="utf-8")
            fake = fake_bin / "fake_pi.py"
            fake.write_text(
                "import json, time\n"
                "for name in ('read', 'bash', 'write'):\n"
                " print(json.dumps({'type':'tool_execution_start','toolName':name}), flush=True)\n"
                " time.sleep(0.6)\n"
                "print(json.dumps({'type':'message_end','message':{'role':'assistant','provider':'krill','model':'grok-4.5','stopReason':'stop','usage':{},'content':[{'type':'text','text':'done'}]}}), flush=True)\n"
                "print(json.dumps({'type':'agent_end'}), flush=True)\n"
                "print(json.dumps({'type':'agent_settled'}), flush=True)\n",
                encoding="utf-8",
            )
            (fake_bin / "pi.cmd").write_text(
                f'@echo off\r\n"{sys.executable}" "{fake}" %*\r\n',
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                "PI_WORKER_DISABLE_CACHE_GC": "1",
            }
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "run_pi_worker.py"),
                    "--cwd",
                    str(source),
                    "--source-cwd",
                    str(source),
                    "--prompt-file",
                    str(prompt),
                    "--mode",
                    "analysis",
                    "--output-dir",
                    str(output),
                    "--timeout-seconds",
                    "1",
                    "--provider",
                    "krill",
                    "--model",
                    "grok-4.5",
                    "--thinking",
                    "high",
                    "--runtime-root",
                    str(root / "runtime"),
                    "--session-id",
                    "timeout-session",
                    "--session-dir",
                    str(root / "runtime" / "sessions" / "timeout-session"),
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(completed.stdout)
            self.assertFalse(result["timedOut"])
            self.assertEqual(result["timeoutMode"], "idle")
            self.assertGreater(result["elapsedSeconds"], 1.5)

    @unittest.skipUnless(os.name == "nt", "Windows integration test")
    def test_stderr_noise_does_not_keep_a_stalled_worker_alive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            source = root / "source"
            output = root / "output"
            fake_bin.mkdir()
            source.mkdir()
            prompt = root / "task.md"
            prompt.write_text("test", encoding="utf-8")
            fake = fake_bin / "fake_pi.py"
            fake.write_text(
                "import sys, time\n"
                "for _ in range(20):\n"
                " print('still noisy', file=sys.stderr, flush=True)\n"
                " time.sleep(0.2)\n",
                encoding="utf-8",
            )
            (fake_bin / "pi.cmd").write_text(
                f'@echo off\r\n"{sys.executable}" "{fake}" %*\r\n',
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                "PI_WORKER_DISABLE_CACHE_GC": "1",
            }
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "run_pi_worker.py"),
                    "--cwd",
                    str(source),
                    "--source-cwd",
                    str(source),
                    "--prompt-file",
                    str(prompt),
                    "--mode",
                    "analysis",
                    "--output-dir",
                    str(output),
                    "--timeout-seconds",
                    "1",
                    "--provider",
                    "krill",
                    "--model",
                    "grok-4.5",
                    "--thinking",
                    "high",
                    "--runtime-root",
                    str(root / "runtime"),
                    "--session-id",
                    "stalled-session",
                    "--session-dir",
                    str(root / "runtime" / "sessions" / "stalled-session"),
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(completed.returncode, 1, completed.stderr)
            result = json.loads(completed.stdout)
            self.assertTrue(result["timedOut"])
            self.assertLess(result["elapsedSeconds"], 3)


if __name__ == "__main__":
    unittest.main()
