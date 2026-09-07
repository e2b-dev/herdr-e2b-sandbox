"""Run the first-party CLI in a PTY; send its token privately through fd 3."""
import codecs
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import tty


class TokenFilter:
    prefix = "sk-ant-oat01-"

    def __init__(self):
        self.pending = ""
        self.secret = None
        self.tokens = set()

    def feed(self, text, final=False):
        self.pending += text
        output = ""
        while self.pending:
            if self.secret is not None:
                char = self.pending[0]
                if char.isascii() and (char.isalnum() or char in "-_"):
                    self.secret += char
                    self.pending = self.pending[1:]
                    if len(self.secret) > 4096:
                        raise ValueError("Unexpected token output")
                    continue
                self.finish_token()
                output += "[token captured]"
            elif self.pending.startswith(self.prefix):
                self.secret = self.prefix
                self.pending = self.pending[len(self.prefix):]
            elif self.prefix.startswith(self.pending):
                break
            else:
                output += self.pending[0]
                self.pending = self.pending[1:]
        if final:
            if self.secret is not None:
                self.finish_token()
                output += "[token captured]"
            # An incomplete token prefix is suppressed at EOF too.
            self.pending = ""
        return output

    def finish_token(self):
        if len(self.secret) >= len(self.prefix) + 32:
            self.tokens.add(self.secret)
        self.secret = None


def main():
    saved = termios.tcgetattr(0) if os.isatty(0) else None
    child, master = pty.fork()
    if child == 0:
        os.close(3)
        os.execvp(sys.argv[1], sys.argv[1:])
    capture = TokenFilter()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    status = None

    def resize(*_):
        size = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8) if os.isatty(0) else struct.pack("HHHH", 24, 80, 0, 0)
        rows, columns, x, y = struct.unpack("HHHH", size)
        # Prevent Ink from inserting hard line breaks inside the captured token.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, max(columns, 1024), x, y))

    def interrupt(*_):
        raise KeyboardInterrupt()

    try:
        resize()
        signal.signal(signal.SIGWINCH, resize)
        signal.signal(signal.SIGTERM, interrupt)
        if saved:
            tty.setraw(0)
        inputs = [master, 0]
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            readable, _, _ = select.select(inputs, [], [], 0.2)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    break
                sys.stdout.write(capture.feed(decoder.decode(data)))
                sys.stdout.flush()
            if 0 in readable:
                data = os.read(0, 65536)
                if data:
                    os.write(master, data)
                else:
                    inputs.remove(0)
        else:
            raise TimeoutError()
        sys.stdout.write(capture.feed(decoder.decode(b"", final=True), final=True))
        sys.stdout.flush()
        _, status = os.waitpid(child, 0)
        if os.waitstatus_to_exitcode(status) != 0 or len(capture.tokens) != 1:
            return 1
        os.write(3, json.dumps({"token": next(iter(capture.tokens))}).encode())
        return 0
    except (KeyboardInterrupt, TimeoutError):
        return 130
    finally:
        if saved:
            termios.tcsetattr(0, termios.TCSADRAIN, saved)
        if status is None:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        os.close(master)


if __name__ == "__main__":
    sys.exit(main())
