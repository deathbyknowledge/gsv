"""Exercise the real installer in disposable pseudo-terminals, with fixture downloads."""
import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time


repository, fixtures, fake_bin = map(Path, sys.argv[1:])
enter = b"\x1b[?1049h"
restore = b"\x1b[0m\x1b[?25h\x1b[?1049l"


def check(case, animated=True, exit_code=0):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        release = root / "release"
        shutil.copytree(fixtures, release)
        (root / "home").mkdir()
        if case == "checksum":
            (release / "gsv-linux-x64").write_text("corrupt")
        if case == "missing-animation":
            (release / "gsv-installer-animation.gz").unlink()
        if case == "corrupt-animation":
            (release / "gsv-installer-animation.gz").write_text("corrupt")
        env = {key: value for key, value in os.environ.items() if not key.startswith("GSV_") and key not in ("CI", "XDG_CONFIG_HOME")}
        env.update(HOME=str(root / "home"), PATH=f"{fake_bin}:{os.environ['PATH']}",
                   TERM="xterm-256color", GSV_VERSION="v-test", GSV_INSTALLER_RELEASE_BOUND="1",
                   GSV_INSTALL_DIR=str(root / "installed"), GSV_TEST_RELEASE_DIR=str(release),
                   GSV_TEST_DOWNLOAD_DELAY="3" if case in ("success", "resize") else "0.7")
        if case == "disabled":
            env["GSV_NO_ANIMATION"] = "1"
        pid, terminal = pty.fork()
        if pid == 0:
            # Size is set before exec, so startup cannot race the first resize.
            size = (20, 40) if case == "small" else (48, 110)
            fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", *size, 0, 0))
            os.execvpe("bash", ["bash", str(repository / "install.sh")], env)
        output = bytearray()
        interrupted = resized = False
        deadline = time.monotonic() + 15
        status = None
        try:
            while time.monotonic() < deadline:
                if select.select([terminal], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(terminal, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    if not chunk:
                        break
                    output.extend(chunk)
                if enter in output and case == "interrupt" and not interrupted:
                    os.write(terminal, b"\x03")
                    interrupted = True
                if b"Downloading GSV\x1b[K" in output and case == "resize" and not resized:
                    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 33, 60, 0, 0))
                    resized = True
            else:
                raise AssertionError(f"{case}: installer did not finish")
            _, status = os.waitpid(pid, 0)
        finally:
            if status is None:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(terminal)
        actual = os.waitstatus_to_exitcode(status)
        assert actual == exit_code, (case, actual, output[-2500:])
        assert (enter in output) == animated, (case, output[-2500:])
        if animated:
            assert output.count(enter) == output.count(restore) == 1, (case, output[-2500:])
        if case == "resize":
            assert resized and output.count(b"\x1b[2J") >= 3, output[-2500:]
        if case == "success":
            assert b"Downloading GSV\x1b[K" in output, output[-2500:]
        if exit_code == 0:
            assert (root / "installed/gsv").is_file(), case
            assert b"Installed gsv, gsvd, Desktop" in output, (case, output[-2500:])
        else:
            assert not (root / "installed/gsv").exists(), case
        if case == "checksum":
            assert b"Checksum verification failed" in output, output[-2500:]


for case in ("success", "resize"):
    check(case)
check("checksum", exit_code=1)
check("interrupt", exit_code=130)
for case in ("small", "disabled", "missing-animation", "corrupt-animation"):
    check(case, animated=False)
print("installer terminal success, resize, interruption, failure and text fallback passed")
