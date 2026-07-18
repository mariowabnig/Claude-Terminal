import importlib.util
import pathlib
import subprocess
import sys
import unittest


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


if __name__ == "__main__":
    unittest.main()
