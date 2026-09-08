# Install and upgrade GSV host applications

The GSV release is one versioned host distribution. The operator CLI (`gsv`),
machine daemon (`gsvd`), Desktop, and Desktop's transcription and gesture-vision
helpers share the version in the repository root `VERSION` file. The CLI
refuses to manage a mismatched daemon.

## Supported release artifacts

| Platform | `gsv` | `gsvd` | Desktop | Transcription | Gestures |
| --- | --- | --- | --- | --- | --- |
| Linux x64 | yes | yes | yes | yes | yes |
| Linux ARM64 | yes | yes | yes | yes | yes |
| macOS Intel | yes | yes | yes | yes | yes |
| macOS Apple Silicon | yes | yes | yes | yes | yes |
| Windows x64 | yes | yes | not yet | not yet | not yet |

Windows ARM64 can run the Windows x64 CLI and daemon through emulation, but it
is not a native release target. Other operating systems and architectures are
not currently published.

## Install

On Linux or macOS:

```bash
curl -fsSL https://install.gsv.space | bash
```

On Windows PowerShell:

```powershell
irm https://install.gsv.space/install.ps1 | iex
```

Use `GSV_CHANNEL=dev` for the moving development channel, or set
`GSV_VERSION=vX.Y.Z` to install an immutable release tag.

## Install location

New installations go to a per-user directory: `~/.gsv/bin` on Linux and macOS,
`%LOCALAPPDATA%\Programs\gsv\bin` on Windows. No `sudo` is involved, the
daemon can update itself there, and `~/.gsv` then holds everything GSV writes
on the machine besides `config.toml` and the service definition. The installer
puts the directory on `PATH` for new shells: one marked, guarded line in
`~/.profile`, plus `~/.bash_profile`, `~/.bashrc`, `~/.zshrc`, and
`~/.config/fish/conf.d/gsv.fish` where those exist, never added twice; on
Windows it is the user `Path` in the registry. Set `GSV_NO_MODIFY_PATH=1` to
skip that and add it yourself. The daemon service never depends on `PATH`; it
is registered with the absolute path of `gsvd`.

`GSV_INSTALL_DIR` overrides the destination. A directory this user cannot write
is installed with `sudo`, and the daemon there cannot update itself.

An existing installation stays where it is. When `GSV_INSTALL_DIR` is unset the
installer updates the directory the `gsvd` service runs from, or a previous
`/usr/local/bin` installation, in place, and prints how to move if that
directory is not user-writable. A daemon that Desktop enrolled from inside its
macOS application bundle is the exception: Desktop updates that bundle as a
whole, so the installer leaves it and its service alone and adds a separate
command-line installation in the default directory. To migrate by hand:

```bash
curl -fsSL https://install.gsv.space | GSV_INSTALL_DIR="$HOME/.gsv/bin" bash
sudo rm /usr/local/bin/gsv /usr/local/bin/gsvd /usr/local/bin/gsv-desktop \
  /usr/local/bin/gsv-transcribe /usr/local/bin/gsv-vision
gsv daemon install
```

Every artifact is checked against the release's `checksums.txt` before an
installed binary is changed. The installer preserves the existing config and
keeps user, Desktop, and driver credentials separate.

## Existing device daemon

When the `gsvd` user service already exists, the installer:

1. records whether it is installed and running;
2. stops it before replacing its executable;
3. transactionally replaces the same-version host binaries;
4. migrates legacy definitions that invoke `gsv device run` to
   `gsvd --foreground` without changing the `gsvd` service identity; and
5. checks the installed versions and service health.

If migration or the health check fails, the previous executable and service
definition are restored. A machine without an existing service is not silently
enrolled; run `gsv daemon install` after configuring a driver credential.

## Automatic daemon updates

A connected machine keeps itself current. When the gateway is redeployed,
`gsvd` learns about it the next time it connects: a gateway that requires a
newer protocol rejects the handshake and names the release it needs, and a
gateway that merely runs a newer release reports it on a successful connect.
In both cases the daemon runs this same installer, pinned to that release,
detached from its own service so the installer can stop, replace, restart,
health-check, and if necessary roll back the daemon exactly as a manual
upgrade would. A stable daemon only follows stable releases; a daemon on the
`dev` channel follows the `dev` tag.

Automatic updates need the install directory to be writable by the user
running `gsvd`, which the per-user default guarantees. Only a pre-existing
system-wide installation, such as one under `/usr/local/bin`, updates manually
until it is migrated, and a daemon inside the Desktop application bundle is
updated by Desktop. The daemon also
only updates itself when a service manager runs it (systemd, launchd, or the
Windows scheduled task), since something has to restart it afterwards; a
`gsvd --foreground` started by hand reports the newer release and leaves the
update to you. The daemon makes at most one attempt per hour and only
ever moves to a release the gateway named. Installer output is written to `~/.gsv/logs/auto-update.log`,
and `gsv daemon diagnostics` shows the latest decision. To turn the mechanism
off:

```bash
gsv config --local set device.auto_update false
```

The daemon reads that setting again at every handshake, so the change applies
the next time it connects; `gsv daemon reload` applies it immediately.

The CLI and Desktop are never replaced while a person is using them. The CLI
prints a hint when the gateway runs a newer release; rerun the installer to
update them.

## Desktop

On Linux and macOS, start or focus the installed app with:

```bash
gsv desktop
```

`gsv desktop status`, `new`, and `use PID` use same-user local IPC. Desktop
connects to the gateway as a user; it does not route chat through `gsvd`.
The installer places `gsv-transcribe` and `gsv-vision` beside Desktop so it can
supervise the exact same-version helpers. The vision executable embeds its
checksum-pinned models; their Apache 2.0 license and provenance are installed
as verified sidecar assets.

The current Desktop release is a command-line executable rather than a macOS
`.app` bundle. It is not code-signed or notarized. A signed/notarized macOS
package requires Apple Developer signing credentials and a notarization secret
to be configured in the release environment. Windows Desktop distribution is
blocked on product support and packaging for the current GPUI version, so the
Windows installer deliberately installs only `gsv` and `gsvd`.

## Manual verification

Release assets include a SHA-256 entry in `checksums.txt`. Verify a downloaded
asset before installation, for example:

```bash
sha256sum -c checksums.txt --ignore-missing
```

After installing the daemon service, inspect it with:

```bash
gsv daemon doctor
gsv daemon status
```
