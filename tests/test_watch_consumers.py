from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import watch_pi_worker as watch  # noqa: E402
from runtime_support import atomic_json  # noqa: E402


class WatchConsumerTests(unittest.TestCase):
    def make_receipt(self, root: Path) -> tuple[Path, dict[str, object]]:
        receipt = {
            "runId": "watch-test",
            "pid": os.getpid(),
            "resultPath": str(root / "pi-result.json"),
            "attentionPath": str(root / "pi-attention.json"),
        }
        path = root / "pi-receipt.json"
        atomic_json(path, receipt)
        return path, receipt

    def test_two_consumers_each_receive_once_without_removing_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path, receipt = self.make_receipt(Path(temporary))
            source = Path(str(receipt["attentionPath"]))
            atomic_json(source, {"sequence": 1, "category": "transport"})
            for consumer in ("thread-a", "thread-b"):
                event = watch.attention(path, receipt, consumer)
                self.assertEqual(event["attention"]["category"], "transport")
                self.assertEqual(event["consumer"], consumer)
                self.assertIsNone(watch.attention(path, receipt, consumer))
            self.assertTrue(source.is_file())

    def test_concurrent_same_consumer_claims_only_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path, receipt = self.make_receipt(Path(temporary))
            atomic_json(Path(str(receipt["attentionPath"])), {"sequence": 1, "category": "transport"})
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: watch.attention(path, receipt), range(8)))
            self.assertEqual(sum(event is not None for event in results), 1)

    def test_legacy_delivery_belongs_only_to_default_consumer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, receipt = self.make_receipt(root)
            atomic_json(root / "pi-attention-delivered-001.json", {"sequence": 1, "category": "transport"})
            self.assertIsNone(watch.attention(path, receipt, "default"))
            for consumer in ("thread-a", "thread-b"):
                self.assertIsNotNone(watch.attention(path, receipt, consumer))
                self.assertIsNone(watch.attention(path, receipt, consumer))

    def test_default_consumer_uses_valid_thread_id(self) -> None:
        for value, expected in (("thread-123", "thread-123"), ("", "default"), ("../bad", "default")):
            with self.subTest(value=value), patch.dict(os.environ, {"CODEX_THREAD_ID": value}):
                self.assertEqual(watch.default_consumer(), expected)

    def test_terminal_cli_is_compact_unless_full_requested(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path, receipt = self.make_receipt(Path(temporary))
            result = {
                "runId": "watch-test", "status": "completed", "turnIndex": 2,
                "finalText": "A ↔ B " * 1000, "toolCalls": [{"output": "large private evidence"}],
            }
            atomic_json(Path(str(receipt["resultPath"])), result)
            warning = {"sequence": 1, "category": "transport"}
            atomic_json(Path(str(receipt["attentionPath"])), warning)
            for full in (False, True):
                completed = subprocess.run(
                    [sys.executable, str(SCRIPTS / "watch_pi_worker.py"), str(path), *(["--full"] if full else [])],
                    capture_output=True, text=True, encoding="utf-8", timeout=5,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                event = json.loads(completed.stdout)
                self.assertEqual(event["event"], "terminal")
                self.assertEqual(event["attention"], warning)
                if full:
                    self.assertEqual(event["result"], result)
                else:
                    self.assertEqual(event["result"]["turnIndex"], 2)
                    self.assertEqual(len(event["result"]["finalText"]), watch.FINAL_TEXT_LIMIT)
                    self.assertTrue(event["result"]["finalTextTruncated"])
                    self.assertNotIn("toolCalls", event["result"])
                    self.assertEqual(event["result"]["resultPath"], receipt["resultPath"])

    @unittest.skipUnless(sys.platform == "win32", "requires native Windows process wait")
    def test_two_waiters_recover_missed_signal_and_return_first_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            idle = root / "idle"
            ready = root / "ready"
            idle.mkdir()
            ready.mkdir()
            idle_path, _ = self.make_receipt(idle)
            ready_path, receipt = self.make_receipt(ready)
            # No event signal at all: this exercises the same durable-file path
            # as a shared event reset by another consumer before being observed.
            code = "import watch_pi_worker as w; w.FALLBACK_MS = 100; raise SystemExit(w.main())"
            waiters = [
                subprocess.Popen(
                    [sys.executable, "-c", code, str(idle_path), str(ready_path),
                     "--consumer", consumer, "--timeout-seconds", "5"],
                    cwd=SCRIPTS, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                )
                for consumer in ("thread-a", "thread-b")
            ]
            try:
                time.sleep(0.3)
                atomic_json(Path(str(receipt["attentionPath"])), {"sequence": 1, "category": "transport"})
                for waiter in waiters:
                    stdout, stderr = waiter.communicate(timeout=3)
                    self.assertEqual(waiter.returncode, 0, stderr)
                    event = json.loads(stdout)
                    self.assertEqual(event["event"], "attention")
                    self.assertEqual(Path(event["receipt"]), ready_path)
            finally:
                for waiter in waiters:
                    if waiter.poll() is None:
                        waiter.kill()
                        waiter.communicate()


if __name__ == "__main__":
    unittest.main()
