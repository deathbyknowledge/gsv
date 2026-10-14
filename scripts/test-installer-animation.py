"""Exercise the real installer in disposable pseudo-terminals, with fixture downloads."""
import errno
import fcntl
import os
from pathlib import Path
import pty
import re
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
sgr = re.compile(rb"\x1b\[[0-9;]*m")
rendered_frame = re.compile(rb"\x1b\[(\d+);1H( *)GSV\x1b\[K\r?\n\r?\n(.*?)Downloading GSV\x1b\[K\x1b\[J", re.DOTALL)


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
        env = {key: value for key, value in os.environ.items() if not key.startswith("GSV_") and key not in ("CI", "XDG_CONFIG_HOME", "DISPLAY", "WAYLAND_DISPLAY", "SSH_CONNECTION", "SSH_TTY")}
        env.update(HOME=str(root / "home"), PATH=f"{fake_bin}:{os.environ['PATH']}",
                   TERM="xterm-256color", GSV_VERSION="v-test", GSV_INSTALLER_RELEASE_BOUND="1",
                   GSV_INSTALL_DIR=str(root / "installed with spaces"), GSV_TEST_RELEASE_DIR=str(release),
                   GSV_TEST_DESKTOP_LOG=str(root / "desktop.log"),
                   GSV_TEST_DOWNLOAD_DELAY="1")
        download_gate = root / "release-download"
        if case in ("success", "resize", "grow", "small", "narrow", "short"):
            env["GSV_TEST_DOWNLOAD_GATE"] = str(download_gate)
        if case == "default-path":
            env.pop("GSV_INSTALL_DIR")
            env["GSV_LEGACY_INSTALL_DIR"] = str(root / "legacy")
        if case == "hangup":
            env["GSV_INSTALL_DIR"] = str(root / "installed")
        installed = Path(env.get("GSV_INSTALL_DIR", root / "home/.gsv/bin"))
        if case not in ("headless", "hangup", "mac"):
            env["WAYLAND_DISPLAY"] = "wayland-fixture"
        if case == "mac":
            env["GSV_TEST_UNAME_S"] = "Darwin"
        if case == "x11":
            env.pop("WAYLAND_DISPLAY")
            env["DISPLAY"] = ":fixture"
        if case == "no-launch":
            env["GSV_NO_LAUNCH"] = "1"
        if case == "no-path":
            env["GSV_NO_MODIFY_PATH"] = "1"
        if case == "ssh":
            env["SSH_CONNECTION"] = "fixture"
        if case == "ci":
            env["CI"] = "true"
        if case == "launch-failure":
            env["GSV_TEST_DESKTOP_FAIL"] = "1"
        if case == "hangup":
            (root / "tmp").mkdir()
            (root / "bin").mkdir()
            (root / "installed").mkdir()
            original = b"#!/bin/sh\nprintf 'previous-version\\n'\n"
            installed_names = ("gsv", "gsvd", "gsv-desktop", "gsv-transcribe", "gsv-vision")
            for name in installed_names:
                target = root / "installed" / name
                target.write_bytes(original)
                target.chmod(0o755)
            service = root / "home/.config/systemd/user/gsvd.service"
            service.parent.mkdir(parents=True)
            service_text = f'[Service]\nExecStart="{root}/installed/gsvd"\n'
            service.write_text(service_text)
            copier = root / "bin/cp"
            copier.write_text(f'''#!/bin/sh
case "$3" in
  */.gsvd.new.*) touch '{root}/replacement-started'; sleep 10 ;;
esac
exec /usr/bin/cp "$@"
''')
            copier.chmod(0o755)
            env.update(PATH=f"{root}/bin:{env['PATH']}", TMPDIR=str(root / "tmp"), GSV_TEST_SYSTEMCTL_LOG=str(root / "service.log"))
        if case == "disabled":
            env["GSV_NO_ANIMATION"] = "1"
        pid, terminal = pty.fork()
        if pid == 0:
            # Size is set before exec, so startup cannot race the first resize.
            size = (20, 40) if case in ("small", "grow") else (48, 110)
            size = {"narrow": (48, 56), "short": (30, 110), "tiny": (1, 1)}.get(case, size)
            fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", *size, 0, 0))
            os.execvpe("bash", ["bash", str(repository / "install.sh")], env)
        output = bytearray()
        interrupted = False
        resize_sizes = [(52, 122), (30, 56), (31, 57), (33, 60)] if case == "resize" else [(48, 110)] if case == "grow" else []
        rendered_sizes = []
        frames_seen = 0
        deadline = time.monotonic() + 20
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
                if case == "hangup" and (root / "replacement-started").exists():
                    assert (root / "installed/gsv").read_bytes() != original
                    os.close(terminal)
                    terminal = None
                    break
                matches = list(rendered_frame.finditer(output))
                if len(matches) > frames_seen:
                    frames_seen = len(matches)
                    match = matches[-1]
                    lines = sgr.sub(b"", match[3]).split(b"\r\n")
                    picture = lines[:-2] if len(lines) > 1 else []
                    dimensions = (len(picture[0]) - len(match[2]), len(picture)) if picture else (0, 0)
                    if not rendered_sizes or rendered_sizes[-1] != dimensions:
                        rendered_sizes.append(dimensions)
                        if resize_sizes:
                            size = resize_sizes.pop(0)
                            fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", *size, 0, 0))
                        elif "GSV_TEST_DOWNLOAD_GATE" in env:
                            download_gate.touch()
            else:
                raise AssertionError(f"{case}: installer did not finish")
            while time.monotonic() < deadline:
                exited, result = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = result
                    break
                time.sleep(0.05)
            assert status is not None, f"{case}: cleanup did not finish"
        finally:
            if status is None:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            if terminal is not None:
                os.close(terminal)
        actual = os.waitstatus_to_exitcode(status)
        assert actual == exit_code, (case, actual, output[-2500:])
        assert (enter in output) == animated, (case, output[-2500:])
        if animated and case != "hangup":
            assert output.count(enter) == output.count(restore) == 1, (case, output[-2500:])
        if case == "resize":
            assert rendered_sizes == [(104, 39), (114, 43), (0, 0), (56, 21), (59, 22)], rendered_sizes
        if case == "grow":
            assert rendered_sizes == [(0, 0), (104, 39)], rendered_sizes
        if case in ("small", "narrow", "short"):
            assert rendered_sizes == [(0, 0)], rendered_sizes
        if case == "success":
            assert b"Downloading GSV\x1b[K" in output, output[-2500:]
        if case == "hangup":
            assert {path.name for path in (root / "installed").iterdir()} == set(installed_names)
            assert all(path.read_bytes() == original for path in (root / "installed").iterdir())
            assert service.read_text() == service_text
            assert not list((root / "tmp").iterdir()), "installer left temporary files after hangup"
            service_log = (root / "service.log").read_text()
            assert service_log.rfind("--user start gsvd.service") > service_log.rfind("--user stop gsvd.service") >= 0
        elif exit_code == 0:
            assert (installed / "gsv").is_file(), case
            assert b"Installed gsv, gsvd, Desktop" in output, (case, output[-2500:])
        else:
            assert not (installed / "gsv").exists(), case
        if case == "checksum":
            assert b"Checksum verification failed" in output, output[-2500:]
        launched = exit_code == 0 and case not in ("headless", "no-launch", "ssh", "ci")
        assert (root / "desktop.log").exists() == launched, (case, output[-2500:])
        if launched:
            command, path = (root / "desktop.log").read_text().splitlines()
            assert command == str(installed / "gsv"), command
            assert (str(installed) in path.split(":")) == (case != "no-path"), path
            if case == "default-path":
                assert "# Added by the GSV installer" in (root / "home/.profile").read_text()
                assert b'Open a new shell, or run now: export PATH="$HOME/.gsv/bin:$PATH"' in output
            if animated:
                assert output.index(restore) < output.index(b"desktop launched"), output[-2500:]
        if case == "launch-failure":
            assert b"fixture desktop launch failed" in output and b"Installation succeeded; retry" in output


for case in ("success", "resize", "grow", "small", "narrow", "short", "tiny", "headless", "no-launch", "no-path", "default-path", "ssh", "x11", "mac", "launch-failure"):
    check(case)
check("checksum", exit_code=1)
check("interrupt", exit_code=130)
check("hangup", exit_code=129)
for case in ("disabled", "ci", "missing-animation", "corrupt-animation"):
    check(case, animated=False)
print("installer terminal resizing, Desktop launch, PATH, interruption, rollback and text fallback passed")
