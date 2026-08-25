from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@unittest.skipUnless(os.name == "nt", "Windows RPC steer integration test")
class PiRpcSteerTests(unittest.TestCase):
    def test_repeated_failures_wake_then_steer_continues_same_worker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            source = root / "source"
            output = root / "output"
            fake_bin.mkdir()
            source.mkdir()
            prompt = root / "task.md"
            prompt.write_text("initial task", encoding="utf-8")
            correction = root / "correction.md"
            correction.write_text("reuse the existing implementation", encoding="utf-8")
            fake = fake_bin / "fake_pi.py"
            fake.write_text(
                "import json, sys, time\n"
                "initial=json.loads(sys.stdin.readline())\n"
                "print(json.dumps({'id':initial['id'],'type':'response','command':'prompt','success':True}),flush=True)\n"
                "print(json.dumps({'type':'agent_start'}),flush=True)\n"
                "for i in range(3):\n"
                " print(json.dumps({'type':'tool_execution_end','toolName':'bash','isError':True,'result':{'error':str(i)}}),flush=True)\n"
                "for line in sys.stdin:\n"
                " command=json.loads(line)\n"
                " if command.get('type')=='steer':\n"
                "  print(json.dumps({'id':command['id'],'type':'response','command':'steer','success':True}),flush=True)\n"
                "  print(json.dumps({'type':'queue_update','steering':[command['message']],'followUp':[]}),flush=True)\n"
                "  print(json.dumps({'type':'extension_error','extensionPath':'guard','error':'second failure'}),flush=True)\n"
                "  time.sleep(0.2)\n"
                "  print(json.dumps({'type':'message_end','message':{'role':'assistant','provider':'opencode-go','model':'deepseek-v4-flash','stopReason':'stop','usage':{},'content':[{'type':'text','text':'corrected'}]}}),flush=True)\n"
                "  print(json.dumps({'type':'agent_end','willRetry':False}),flush=True)\n"
                "  print(json.dumps({'type':'agent_settled'}),flush=True)\n"
                "  break\n",
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
                "PYTHONIOENCODING": "utf-8",
            }

            started = self.run_command(
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
                    "10",
                ],
                env,
            )
            self.assertEqual(started.returncode, 0, started.stderr)
            receipt = output / "pi-receipt.json"

            first = self.run_command(
                [sys.executable, str(SCRIPTS / "watch_pi_worker.py"), str(receipt), "--timeout-seconds", "5"],
                env,
            )
            first_event = json.loads(first.stdout)
            self.assertEqual(first_event["attention"]["category"], "repeated_tool_errors")
            self.assertEqual(len(first_event["attention"]["recentToolErrors"]), 3)
            self.assertEqual(first_event["lifecycleState"], "running")

            steered = self.run_command(
                [
                    sys.executable,
                    str(SCRIPTS / "steer_pi_worker.py"),
                    str(receipt),
                    "--message-file",
                    str(correction),
                    "--timeout-seconds",
                    "5",
                ],
                env,
            )
            steer_result = json.loads(steered.stdout)
            self.assertTrue(steer_result["acknowledged"])
            self.assertTrue(steer_result["accepted"])

            second = self.run_command(
                [sys.executable, str(SCRIPTS / "watch_pi_worker.py"), str(receipt), "--timeout-seconds", "5"],
                env,
            )
            self.assertEqual(json.loads(second.stdout)["attention"]["category"], "extension_error")
            terminal = self.run_command(
                [sys.executable, str(SCRIPTS / "watch_pi_worker.py"), str(receipt), "--timeout-seconds", "5"],
                env,
            )
            self.assertEqual(json.loads(terminal.stdout)["event"], "terminal")
            self.assertEqual(len(list(output.glob("pi-attention-delivered-*.json"))), 2)

    def run_command(self, command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=15,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed
