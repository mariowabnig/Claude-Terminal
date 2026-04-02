"""
PTY bridge — spawns a command inside a real PTY so the child process
gets full TTY support (colors, interactive mode, escape sequences).

Used by the Obsidian plugin to give Claude Code a proper terminal.

stdin  → master fd (forwarded to child)
stdout ← master fd (child output)
fd 3   → resize channel: send "cols,rows\n" to resize the PTY
"""
import sys, os, struct, fcntl, termios, pty, signal, threading


def main():
    cmd = sys.argv[1:]
    if not cmd:
        sys.exit(1)

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
                os.write(master_fd, data)
            except OSError:
                break

    threading.Thread(target=read_stdin, daemon=True).start()

    # Read fd 3 (resize channel) if the caller opened it
    try:
        os.fstat(3)

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
                        parts = line.decode().strip().split(',')
                        if len(parts) == 2:
                            try:
                                handle_resize(int(parts[0]), int(parts[1]))
                            except ValueError:
                                pass  # ignore malformed resize data
                except OSError:
                    break

        threading.Thread(target=read_resize, daemon=True).start()
    except Exception:
        pass

    # Forward master → stdout
    while True:
        try:
            data = os.read(master_fd, 4096)
            if not data:
                break
            os.write(1, data)
            sys.stdout.flush()
        except OSError:
            break

    # Wait for child to exit
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass


if __name__ == '__main__':
    main()
