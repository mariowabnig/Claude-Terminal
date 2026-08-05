import importlib.util
import pathlib
import signal
import subprocess
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
BRIDGE_PATH = ROOT / "pty-bridge.py"
SPEC = importlib.util.spec_from_file_location("pty_bridge", BRIDGE_PATH)
PTY_BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(PTY_BRIDGE)


class ResizeParsingTests(unittest.TestCase):
    def test_accepts_positive_terminal_size(self):
        self.assertEqual(PTY_BRIDGE.parse_resize_line(b"120,40\n"), (120, 40))

    def test_rejects_malformed_or_non_positive_sizes(self):
        for value in (b"", b"wide,tall", b"80", b"0,24", b"80,-1", b"\xff,24"):
            with self.subTest(value=value):
                self.assertIsNone(PTY_BRIDGE.parse_resize_line(value))


class WriteTests(unittest.TestCase):
    def test_write_all_retries_partial_writes(self):
        written_chunks = []

        def partial_write(_fd, data):
            chunk = bytes(data[:2])
            written_chunks.append(chunk)
            return len(chunk)

        with mock.patch.object(PTY_BRIDGE.os, "write", side_effect=partial_write):
            PTY_BRIDGE.write_all(1, b"abcdef")

        self.assertEqual(b"".join(written_chunks), b"abcdef")


class BridgeProcessTests(unittest.TestCase):
    def test_forwards_child_output(self):
        result = subprocess.run(
            [sys.executable, str(BRIDGE_PATH), "/bin/sh", "-c", "printf hello"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"hello", result.stdout)

    def test_propagates_child_exit_code(self):
        result = subprocess.run(
            [sys.executable, str(BRIDGE_PATH), "/bin/sh", "-c", "exit 7"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 7)

    def test_forwards_termination_to_child_process_group(self):
        child_code = (
            "import signal, sys, time\n"
            "signal.signal(signal.SIGTERM, lambda *_: sys.exit(23))\n"
            "print('ready', flush=True)\n"
            "while True: time.sleep(1)\n"
        )
        proc = subprocess.Popen(
            [sys.executable, str(BRIDGE_PATH), sys.executable, "-c", child_code],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            self.assertIn(b"ready", proc.stdout.readline())
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=3)
            self.assertEqual(proc.returncode, 23)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
