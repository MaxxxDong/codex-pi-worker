from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import continue_pi_worker  # noqa: E402


@unittest.skipUnless(os.name == "nt", "Windows continuation integration test")
class SessionContinuationTests(unittest.TestCase):
    def test_continuation_rollback_removes_long_output_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            runtime = base / "runtime"
            output = base / "output"
            source = base / "source"
            session = runtime / "sessions" / "session"
            source.mkdir()
            session.mkdir(parents=True)
            prompt = base / "prompt.md"
            prompt.write_text("continue", encoding="utf-8")
            result = output / "pi-result.json"
            receipt = output / "pi-receipt.json"
            output.mkdir()
            result.write_text("{}", encoding="utf-8")
            receipt.write_text(
                json.dumps(
                    {
                        "runId": "owner",
                        "pid": 0,
                        "resultPath": str(result),
                        "latestReceiptPath": str(receipt),
                        "ownerReceiptPath": str(receipt),
                        "cleanupStatus": "pending_review",
                        "sessionDir": str(session),
                        "sessionId": "session",
                        "runtimeRoot": str(runtime),
                        "executionCwd": str(source),
                        "sourceCwd": str(source),
                        "sourceRoot": str(source),
                        "outputDir": str(output),
                        "mode": "analysis",
                        "provider": "krill",
                        "model": "grok-4.5",
                        "thinking": "high",
                        "lastTurnIndex": 1,
                    }
                ),
                encoding="utf-8",
            )

            def fail_after_creating_long_path(*args: object, **kwargs: object) -> None:
                deep = output / "turns" / "turn-002"
                while len(str(deep / "payload.txt")) <= 300:
                    deep /= "continuation-segment-0123456789"
                os.makedirs("\\\\?\\" + str(deep))
                with open("\\\\?\\" + str(deep / "payload.txt"), "w", encoding="utf-8") as handle:
                    handle.write("payload")
                raise OSError("launch failed")

            argv = [
                "continue_pi_worker.py",
                str(receipt),
                "--prompt-file",
                str(prompt),
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(continue_pi_worker.subprocess, "Popen", side_effect=fail_after_creating_long_path),
                self.assertRaisesRegex(OSError, "launch failed"),
            ):
                continue_pi_worker.main()
            self.assertFalse((output / "turns" / "turn-002").exists())
            self.assertFalse(any((runtime / "active").glob("*.json")))
            restored = json.loads(receipt.read_text(encoding="utf-8"))
            self.assertEqual(restored["latestReceiptPath"], str(receipt.resolve()))
            self.assertEqual(restored["cleanupStatus"], "pending_review")

    def test_continuation_rechecks_finalization_under_runtime_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            runtime = base / "runtime"
            output = base / "output"
            source = base / "source"
            session = runtime / "sessions" / "session"
            source.mkdir()
            session.mkdir(parents=True)
            output.mkdir()
            prompt = base / "prompt.md"
            prompt.write_text("continue", encoding="utf-8")
            result = output / "pi-result.json"
            receipt = output / "pi-receipt.json"
            result.write_text("{}", encoding="utf-8")
            receipt.write_text(
                json.dumps(
                    {
                        "runId": "owner",
                        "pid": 0,
                        "resultPath": str(result),
                        "latestReceiptPath": str(receipt),
                        "ownerReceiptPath": str(receipt),
                        "cleanupStatus": "pending_review",
                        "sessionDir": str(session),
                        "sessionId": "session",
                        "runtimeRoot": str(runtime),
                        "executionCwd": str(source),
                        "sourceCwd": str(source),
                        "sourceRoot": str(source),
                        "outputDir": str(output),
                        "mode": "analysis",
                        "provider": "opencode-go",
                        "model": "deepseek-v4-flash",
                        "thinking": "max",
                        "lastTurnIndex": 1,
                    }
                ),
                encoding="utf-8",
            )

            @contextmanager
            def finalize_before_lock(_root: Path):
                owner = json.loads(receipt.read_text(encoding="utf-8"))
                owner["cleanupStatus"] = "settled"
                receipt.write_text(json.dumps(owner), encoding="utf-8")
                yield

            argv = ["continue_pi_worker.py", str(receipt), "--prompt-file", str(prompt)]
            with (
                patch.object(sys, "argv", argv),
                patch.object(continue_pi_worker, "runtime_lock", finalize_before_lock),
                self.assertRaisesRegex(SystemExit, "already finalized"),
            ):
                continue_pi_worker.main()
            self.assertFalse((output / "turns" / "turn-002").exists())

    def test_finalize_accept_requires_integrated_flag_for_patch_only_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            output.mkdir()
            result_path = output / "pi-result.json"
            receipt_path = output / "pi-receipt.json"
            result_path.write_text(
                json.dumps({"cleanupStatus": "pending_review", "changedFiles": [], "patch": {"bytes": 1}}),
                encoding="utf-8",
            )
            receipt_path.write_text(
                json.dumps({"runId": "patch-only", "resultPath": str(result_path), "worktreePath": None}),
                encoding="utf-8",
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "finalize_pi_worker.py"),
                    str(receipt_path),
                    "--decision",
                    "accepted",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("--changes-integrated", completed.stderr)

    def test_finalize_removes_long_path_worktree_after_git_cleanup_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "source"
            runtime = base / "runtime"
            worktree = runtime / "worktrees" / "longpath1234"
            output = base / "output"
            source.mkdir()
            output.mkdir()
            for command in (
                ["git", "init", str(source)],
                ["git", "-C", str(source), "config", "user.email", "pi-test@example.invalid"],
                ["git", "-C", str(source), "config", "user.name", "Pi Test"],
            ):
                subprocess.run(command, check=True, capture_output=True)
            (source / "tracked.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "tracked.txt"], check=True)
            subprocess.run(
                ["git", "-C", str(source), "commit", "-m", "base"],
                check=True,
                capture_output=True,
            )
            worktree.parent.mkdir(parents=True)
            subprocess.run(
                ["git", "-C", str(source), "worktree", "add", "--detach", str(worktree)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["git", "-C", str(source), "config", "core.longpaths", "false"],
                check=True,
            )
            deep = worktree
            while len(str(deep / "payload.txt")) <= 300:
                deep /= "gradle-build-segment-0123456789"
            extended = "\\\\?\\" + str(deep)
            os.makedirs(extended)
            with open(extended + "\\payload.txt", "w", encoding="utf-8") as handle:
                handle.write("generated")

            result_path = output / "pi-result.json"
            receipt_path = output / "pi-receipt.json"
            result_path.write_text(
                json.dumps({"status": "completed", "cleanupStatus": "pending_review", "changedFiles": []}),
                encoding="utf-8",
            )
            receipt_path.write_text(
                json.dumps(
                    {
                        "runId": "long-path-cleanup",
                        "resultPath": str(result_path),
                        "sourceRoot": str(source),
                        "worktreePath": str(worktree),
                        "sessionDir": None,
                        "runtimeRoot": str(runtime),
                        "ownerReceiptPath": str(receipt_path),
                        "latestReceiptPath": str(receipt_path),
                    }
                ),
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "finalize_pi_worker.py"),
                    str(receipt_path),
                    "--decision",
                    "rejected",
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env={**os.environ, "PI_WORKER_ROOT": str(runtime)},
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertFalse(worktree.exists())
            registered = subprocess.run(
                ["git", "-C", str(source), "worktree", "list", "--porcelain"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            self.assertNotIn(str(worktree), registered)

    def test_finalize_accepts_pre_session_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            output.mkdir()
            result_path = output / "pi-result.json"
            receipt_path = output / "pi-receipt.json"
            result_path.write_text(
                json.dumps({"status": "failed", "cleanupStatus": "pending_review", "changedFiles": []}),
                encoding="utf-8",
            )
            receipt_path.write_text(
                json.dumps(
                    {
                        "runId": "legacy",
                        "resultPath": str(result_path),
                        "sourceRoot": str(root),
                        "worktreePath": None,
                    }
                ),
                encoding="utf-8",
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "finalize_pi_worker.py"),
                    str(receipt_path),
                    "--decision",
                    "rejected",
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env={**os.environ, "PI_WORKER_ROOT": str(root / "runtime")},
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIsNone(json.loads(completed.stdout)["sessionRemoved"])

    def test_terminal_followup_reuses_session_then_finalize_removes_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            source = root / "source"
            output = root / "output"
            fake_bin.mkdir()
            source.mkdir()
            first_prompt = root / "first.md"
            second_prompt = root / "second.md"
            first_prompt.write_text("FIRST", encoding="utf-8")
            second_prompt.write_text("SECOND", encoding="utf-8")

            fake = fake_bin / "fake_pi.py"
            fake.write_text(
                "import json, pathlib, sys\n"
                "args=sys.argv[1:]\n"
                "session_dir=pathlib.Path(args[args.index('--session-dir')+1])\n"
                "session_dir.mkdir(parents=True, exist_ok=True)\n"
                "state=session_dir/'state.txt'\n"
                "previous=state.read_text(encoding='utf-8') if state.exists() else 'NONE'\n"
                "command=json.loads(sys.stdin.readline())\n"
                "prompt=command['message']\n"
                "state.write_text(prompt, encoding='utf-8')\n"
                "turn=1 if previous=='NONE' else 2\n"
                "text=f'TURN={turn} PREV={previous} PROMPT={prompt}'\n"
                "print(json.dumps({'type':'message_end','message':{'role':'assistant','provider':'krill','model':'grok-4.5','stopReason':'stop','usage':{},'content':[{'type':'text','text':text}]}}), flush=True)\n"
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
                "PI_WORKER_ROOT": str(root / "runtime"),
                "PI_WORKER_DISABLE_CACHE_GC": "1",
                "LOCALAPPDATA": str(root / "local"),
                "PYTHONIOENCODING": "cp936",
            }

            first = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "start_pi_worker.py"),
                    "--cwd",
                    str(source),
                    "--prompt-file",
                    str(first_prompt),
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
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            owner_receipt = output / "pi-receipt.json"
            first_receipt = json.loads(first.stdout)
            self._watch(owner_receipt, env)
            first_result = json.loads((output / "pi-result.json").read_text(encoding="utf-8"))
            self.assertEqual(first_result["turnIndex"], 1)
            self.assertIn("PROMPT=FIRST", first_result["finalText"])
            self.assertTrue(Path(first_receipt["sessionDir"]).is_dir())

            continued = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "continue_pi_worker.py"),
                    str(owner_receipt),
                    "--prompt-file",
                    str(second_prompt),
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(continued.returncode, 0, continued.stderr)
            second_receipt = json.loads(continued.stdout)
            second_receipt_path = Path(second_receipt["outputDir"]) / "pi-receipt.json"
            watched = self._watch(owner_receipt, env)
            self.assertEqual(watched["result"]["turnIndex"], 2)
            second_result = json.loads(Path(second_receipt["resultPath"]).read_text(encoding="utf-8"))
            self.assertEqual(second_result["turnIndex"], 2)
            self.assertIn("PREV=FIRST", second_result["finalText"])
            self.assertIn("PROMPT=SECOND", second_result["finalText"])

            finalized = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "finalize_pi_worker.py"),
                    str(second_receipt_path),
                    "--decision",
                    "rejected",
                ],
                capture_output=True,
                text=True,
                encoding="cp936",
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            self.assertEqual(finalized.returncode, 0, finalized.stderr)
            self.assertFalse(Path(first_receipt["sessionDir"]).exists())
            owner = json.loads(owner_receipt.read_text(encoding="utf-8"))
            self.assertEqual(owner["cleanupStatus"], "settled")
            job = json.loads(
                (Path(env["PI_WORKER_ROOT"]) / "jobs" / f"{first_receipt['runId']}.json").read_text(encoding="utf-8")
            )
            self.assertEqual(job["state"], "settled")

    def _watch(self, receipt: Path, env: dict[str, str]) -> dict[str, object]:
        watched = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "watch_pi_worker.py"),
                str(receipt),
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
        self.assertEqual(watched.returncode, 0, watched.stderr)
        result = json.loads(watched.stdout)
        self.assertEqual(result["event"], "terminal")
        return result


if __name__ == "__main__":
    unittest.main()
