from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import run_pi_worker as runner  # noqa: E402


class FakeProcess:
    def __init__(self, events: list[dict]):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b"".join((json.dumps(event) + "\n").encode() for event in events))
        self.stderr = io.BytesIO()
        self.returncode = 0

    def poll(self):
        return None

    def wait(self, timeout=None):
        return 0


class RunnerAlignmentTests(unittest.TestCase):
    def test_provider_error_is_preserved_and_redacted(self):
        raw = json.dumps({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "error", "content": [],
            "errorMessage": "400 insufficient credits sk-abcdefghijklmnopqrstuvwxyz123456",
        }}).encode()
        compact = runner.compact_event(raw)
        self.assertIn(b"insufficient credits", compact)
        self.assertNotIn(b"sk-abcdefghijklmnopqrstuvwxyz123456", compact)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "events.jsonl"
            path.write_bytes(compact)
            self.assertIn("insufficient credits", runner.parse_events(path)["providerError"])

    def arguments(self, root: Path, extra: list[str] | None = None) -> argparse.Namespace:
        argv = [
            "runner", "--cwd", str(root), "--source-cwd", str(root),
            "--prompt-file", str(root / "task.md"), "--output-dir", str(root / "output"),
            "--runtime-root", str(root / "runtime"), "--session-id", "test-session",
            "--session-dir", str(root / "session"), *(extra or []),
        ]
        with patch.object(sys, "argv", argv):
            return runner.parse_args()

    def execute(self, mode="analysis", guarded=False, tools=None, extra=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "task.md").write_text("test task", encoding="utf-8")
            args = self.arguments(root, ["--mode", mode, *( ["--guarded"] if guarded else []), *(extra or [])])
            events = [
                *(tools or []),
                {"type": "message_end", "message": {
                    "role": "assistant", "provider": args.provider, "model": args.model,
                    "stopReason": "stop", "content": [{"type": "text", "text": "done"}],
                }},
                {"type": "agent_settled"},
            ]
            process = FakeProcess(events)
            env = {"UV_CACHE_DIR": "uv", "PIP_CACHE_DIR": "pip", "npm_config_cache": "npm"}
            with ExitStack() as stack:
                stack.enter_context(patch.object(runner.shutil, "which", return_value="pi-test"))
                environment = stack.enter_context(patch.object(runner, "worker_environment", return_value=(env, {})))
                stack.enter_context(patch.object(runner, "cleanup_run_temp", return_value={"status": "removed"}))
                stack.enter_context(patch.object(runner, "release_cache", return_value={}))
                stack.enter_context(patch.object(runner, "record_job"))
                stack.enter_context(patch.object(runner, "emit_json"))
                snapshot = stack.enter_context(patch.object(runner, "capture_source_snapshot", return_value={"status": [], "fingerprint": ""}))
                patch_writer = stack.enter_context(patch.object(runner, "write_patch", return_value=None))
                stack.enter_context(patch.object(runner.subprocess, "run", side_effect=AssertionError("non-Git directory must not run git")))
                popen = stack.enter_context(patch.object(runner.subprocess, "Popen", return_value=process))
                terminated = stack.enter_context(patch.object(runner, "terminate_process_tree"))
                self.assertEqual(runner.main(args), 0)
                self.assertEqual(environment.call_args.kwargs, {"guarded": guarded})
                result = json.loads((root / "output" / "pi-result.json").read_text(encoding="utf-8"))
                progress = json.loads((root / "output" / "pi-progress.json").read_text(encoding="utf-8"))
                attention_path = root / "output" / "pi-attention.json"
                attention = json.loads(attention_path.read_text(encoding="utf-8")) if attention_path.exists() else None
                self.assertFalse(terminated.called)
                return popen.call_args.args[0], result, progress, attention, snapshot.called, patch_writer.called

    def test_cli_defaults_and_native_provider_names(self):
        args = self.arguments(Path("."), ["--provider", "custom-provider", "--model", "vendor/model"])
        self.assertEqual(args.timeout_seconds, 0)
        self.assertEqual(args.startup_attention, 60)
        self.assertEqual(args.silent_reminder, 600)
        self.assertIsNone(args.progress_reminder)
        self.assertFalse(args.guarded)
        self.assertEqual(args.model, "vendor/model")

    def test_native_analysis_keeps_extensions_and_uses_prompt_only_read_only(self):
        command, result, progress, _, _, patch_written = self.execute()
        self.assertNotIn("--tools", command)
        self.assertIn("--approve", command)
        self.assertTrue(any(value.endswith("pi_worker_native_tools.mjs") for value in command))
        self.assertFalse(any(value.endswith("pi_worker_guard.mjs") for value in command))
        self.assertIn("read-only task", command[command.index("--append-system-prompt") + 1])
        self.assertEqual(result["permissionProfile"]["analysisReadOnly"], "prompt-only")
        self.assertEqual(result["permissionProfile"]["name"], "native-unrestricted")
        self.assertEqual(result["timeoutMode"], "disabled")
        self.assertEqual(result["reminders"]["progressReminderSeconds"], 0)
        self.assertEqual(progress["eventCount"], 2)
        self.assertIsNotNone(progress["firstEventAt"])
        self.assertFalse(patch_written)

    def test_guarded_restores_original_allowlist_without_approve(self):
        command, result, *_ = self.execute(guarded=True)
        self.assertNotIn("--approve", command)
        self.assertEqual(command[command.index("--tools") + 1], runner.ANALYSIS_TOOLS)
        self.assertTrue(any(value.endswith("pi_worker_guard.mjs") for value in command))
        self.assertEqual(result["permissionProfile"]["name"], "guarded")

    def test_in_place_non_git_skips_snapshots_and_patch_and_keeps_write_guidance(self):
        command, result, _, _, snapshot, patch_written = self.execute(mode="in-place")
        self.assertFalse(snapshot)
        self.assertFalse(patch_written)
        self.assertEqual(result["changeTracking"], "unavailable-non-git")
        self.assertEqual(result["reminders"]["progressReminderSeconds"], 600)
        self.assertIn("Work directly here", command[command.index("--append-system-prompt") + 1])

    def test_implementation_still_collects_snapshot_and_patch(self):
        _, result, _, _, snapshot, patch_written = self.execute(mode="implementation")
        self.assertTrue(snapshot)
        self.assertTrue(patch_written)
        self.assertEqual(result["reminders"]["progressReminderSeconds"], 600)

    def test_explicit_pi_binary_and_idle_timeout_are_preserved(self):
        with patch.dict(os.environ, {"SUBWORKER_PI_BIN": "explicit-pi", "PI_WORKER_PI_BIN": "legacy-pi"}):
            command, result, *_ = self.execute(extra=["--timeout-seconds", "20", "--progress-reminder", "17"])
        self.assertEqual(command[0], "explicit-pi")
        self.assertEqual(result["timeoutMode"], "idle")
        self.assertEqual(result["timeoutSeconds"], 20)
        self.assertEqual(result["reminders"]["progressReminderSeconds"], 17)

    def test_only_three_consecutive_same_category_tool_errors_raise_attention(self):
        def error(text, tool="bash"):
            return {"type": "tool_execution_end", "toolName": tool, "isError": True, "result": {"error": text}}

        _, _, _, attention, *_ = self.execute(tools=[error("missing file"), error("denied"), error("timeout")])
        self.assertIsNone(attention)
        _, _, _, attention, *_ = self.execute(tools=[error(f"missing item {i}") for i in range(3)])
        self.assertEqual(attention["category"], "repeated_tool_errors")
        self.assertEqual(len(attention["recentToolErrors"]), 3)
        self.assertEqual(attention["progress"]["toolCompletions"], 3)
        _, _, _, attention, *_ = self.execute(tools=[
            error("missing"), error("missing"), {"type": "tool_execution_end", "toolName": "bash", "isError": False}, error("missing"),
        ])
        self.assertIsNone(attention)

    def test_soft_reminders_reset_on_activity_and_tool_progress(self):
        progress = runner.ProgressTracker(0, startup=60, silent=600, progress=600)
        self.assertEqual(progress.due_reminders(59), [])
        self.assertEqual(progress.due_reminders(60), ["startup_attention"])
        self.assertEqual(progress.due_reminders(61), [])
        progress.observe(100, {"type": "message_update"})
        self.assertEqual(progress.due_reminders(600), ["progress_reminder"])
        self.assertEqual(progress.due_reminders(700), ["silent_reminder"])
        progress.observe(800, {"type": "tool_execution_start", "toolName": "bash"})
        progress.observe(1000, {"type": "message_update"})
        self.assertEqual(progress.due_reminders(1399), [])
        self.assertEqual(progress.due_reminders(1400), [])
        self.assertEqual(progress.snapshot(1400)["activeTool"], "bash")
        self.assertEqual(progress.due_reminders(1600), ["silent_reminder"])
        progress.observe(1700, {"type": "tool_execution_end", "toolName": "bash"})
        progress.observe(2250, {"type": "message_update"})
        self.assertEqual(progress.due_reminders(2300), ["progress_reminder"])

    def test_zero_disables_all_soft_reminders(self):
        progress = runner.ProgressTracker(0, startup=0, silent=0, progress=0)
        self.assertEqual(progress.due_reminders(999999), [])
        progress.observe(1, {"type": "agent_start"})
        self.assertEqual(progress.due_reminders(999999), [])

    def test_new_attention_replaces_existing_attention_with_increasing_sequence(self):
        _, _, _, attention, *_ = self.execute(tools=[
            {"type": "extension_error", "error": "first error"},
            {"type": "auto_retry_end", "success": False},
        ])
        self.assertEqual(attention["category"], "provider_retry_failed")
        self.assertEqual(attention["sequence"], 2)


if __name__ == "__main__":
    unittest.main()
