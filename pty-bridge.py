"""
PTY bridge — spawns a command inside a real PTY so the child process
gets full TTY support (colors, interactive mode, escape sequences).

Used by the Obsidian plugin to give Claude Code a proper terminal.

stdin  → master fd (forwarded to child)
stdout ← master fd (child output)
fd 3   → resize channel: send "cols,rows\n" to resize the PTY
"""
import fcntl
import os
import pty
import signal
import struct
import sys
import termios
import threading


def parse_resize_line(line):
    try:
        cols_text, rows_text = line.decode().strip().split(',')
        cols, rows = int(cols_text), int(rows_text)
    except (UnicodeDecodeError, ValueError):
        return None
    return (cols, rows) if cols > 0 and rows > 0 else None


def write_all(fd, data):
    remaining = memoryview(data)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise OSError("write returned no progress")
        remaining = remaining[written:]


def forward_signal(pid, signum):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        return
    except OSError:
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass


def main():
    cmd = sys.argv[1:]
    if not cmd:
        return 1

    # Detect the optional resize channel before opening the PTY. Otherwise the
    # newly allocated master can itself become fd 3 and be mistaken for it,
    # causing the resize thread to consume and discard all terminal output.
    try:
        os.fstat(3)
        has_resize_channel = True
    except OSError:
        has_resize_channel = False

    master_fd, slave_fd = pty.openpty()

    pid = os.fork()
    if pid == 0:
        # Child — attach to the slave PTY and exec the command
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(master_fd)
        os.close(slave_fd)
        os.execvp(cmd[0], cmd)

    # Parent
    os.close(slave_fd)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, lambda received, _frame, child_pid=pid: forward_signal(child_pid, received))

    def handle_resize(cols, rows):
        try:
            s = struct.pack('HHHH', rows, cols, 0, 0)
            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, s)
            os.kill(pid, signal.SIGWINCH)
        except Exception:
            pass

    # Forward stdin → master
    def read_stdin():
        while True:
            try:
                data = os.read(0, 4096)
                if not data:
                    break
                write_all(master_fd, data)
            except OSError:
                break

    threading.Thread(target=read_stdin, daemon=True).start()

    # Read fd 3 (resize channel) if the caller opened it
    if has_resize_channel:
        def read_resize():
            buf = b''
            while True:
                try:
                    data = os.read(3, 1024)
                    if not data:
                        break
                    buf += data
                    while b'\n' in buf:
                        line, buf = buf.split(b'\n', 1)
                        size = parse_resize_line(line)
                        if size:
                            handle_resize(*size)
                except OSError:
                    break

        threading.Thread(target=read_resize, daemon=True).start()

    # Forward master → stdout
    while True:
        try:
            data = os.read(master_fd, 4096)
            if not data:
                break
            write_all(1, data)
        except OSError:
            break

    # Wait for child to exit
    try:
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status)
    except Exception:
        return 1


if __name__ == '__main__':
    sys.exit(main())
