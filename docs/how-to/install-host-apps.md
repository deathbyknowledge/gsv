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
| Windows 10+ x64 | yes | yes | yes | yes | yes |

Windows ARM64 is not a supported release target. Other operating systems and architectures are
not currently published.

## Install

On Linux or macOS:

```bash
curl -fsSL https://install.gsv.space | bash
```

On Windows, download `gsv-desktop-windows-x64-setup.exe` from the release and
run it, or use Windows PowerShell 5.1 or PowerShell 7:

```powershell
irm https://install.gsv.space/install.ps1 | iex
```

After a successful installation in a local graphical terminal, the script opens
GSV Desktop automatically. Set `GSV_NO_LAUNCH=1` to skip opening it. Headless,
SSH, CI and redirected sessions do not launch Desktop. A launch failure leaves
the installation intact and prints the error so you can fix it and run
`gsv desktop` again.

The setup executable installs all five applications, adds a Start-menu shortcut,
and registers an Apps uninstall entry. Setup upgrades reuse the installation
directory selected during the previous setup. The ZIP contains the same payload with
`install.ps1`; extract it and run `./install.ps1 -AssetDirectory .`.
Desktop needs WebView2 and the Visual C++ x64 runtime; the installer downloads
and verifies Microsoft's installers when either is missing. Internet access is
needed for missing runtimes even when the GSV payload is already downloaded.

For a Windows server without Desktop:

```powershell
Invoke-WebRequest -UseBasicParsing https://install.gsv.space/install.ps1 -OutFile install.ps1
./install.ps1 -Headless
```

This installs only `gsv.exe` and `gsvd.exe`, plus the Visual C++ runtime if needed.
It does not install WebView2. Pair the computer with the invitation
from Fleet, then inspect it with `gsv daemon status`.

Use `GSV_CHANNEL=dev` for the moving development channel, or set
`GSV_VERSION=vX.Y.Z` to install an immutable release tag.

The Linux and macOS installer shows a satellite animation in a terminal with
enough space, using the terminal's current font. It scales the cached frames to
the current terminal dimensions, preserves their proportions, and responds to
resizing while the real installation runs. Below 57 columns or 31 rows it shows
only text; growing the terminal brings the satellite back, even when it started
small. Completion or interruption restores the terminal and the install log.
Redirected output and CI keep ordinary text output. Set `GSV_NO_ANIMATION=1`
to use text explicitly.

## Sign-in and multiple windows

**Open your space** lets you choose an owned space or enter a handle or domain.
The address form also works for spaces owned by someone else or served by another
operator. Contact invitation links use the same address entry before your normal
space sign-in and explicit acceptance.

Desktop and browser windows can stay connected to the same space at once. They
receive new conversation messages live and refresh server state after a
reconnect. A remembered space sign-in lasts 30 days and renews during use.
Browser tabs share renewal and sign-out; Desktop has its own stored session.
A temporary network interruption reconnects without asking you to sign in again.

If setup of a space claimed with an invite code was interrupted, **Continue setup** returns to owner email
sign-in and the existing claimed space. For the Desktop app's configured operator,
this stays inside the app; another operator's recovery page opens in the browser.
The owner signs in with the email used to claim the invitation, then continues
setup with fresh authorization instead of claiming another space.
For a setup link issued directly by an operator, ask that operator for a new link.
An incompatible client or rejected connection shows the gateway's error instead
of retrying indefinitely.

## Install location

New installations go to a per-user directory: `~/.gsv/bin` on Linux and macOS,
`%LOCALAPPDATA%\Programs\gsv\bin` on Windows. On Linux and macOS, no `sudo`
is involved, the daemon can update itself there, and `~/.gsv` holds the host
tools, logs and model cache. Windows service registration and updates require
administrator approval; its protected copy is described below. Desktop keeps its
private session and webview state in the platform application data directory. The installer
puts the directory on `PATH` for new shells: one marked, guarded line in
`~/.profile`, plus `~/.bash_profile`, `~/.bashrc`, `~/.zshrc`, and
`~/.config/fish/conf.d/gsv.fish` where those exist, never added twice; on
Windows it is the user `Path` in the registry. Set `GSV_NO_MODIFY_PATH=1` to
skip that and add it yourself. The daemon service never depends on `PATH`; it
is registered with the absolute path of `gsvd`.

Unless `GSV_NO_MODIFY_PATH=1`, the installer also exports the updated `PATH`
for its own process and Desktop.
On Unix, a script piped into `bash` cannot change its parent terminal's
environment. To use `gsv` in that same terminal afterward, open a new shell or
run `export PATH="$HOME/.gsv/bin:$PATH"`. Desktop opens without this extra step.
The PowerShell `iex` command updates the current session's `PATH` directly.

`GSV_INSTALL_DIR` overrides the destination. On Unix, a directory this user cannot
write is installed with `sudo`, and the daemon there cannot update itself.

On Unix, an existing installation stays where it is. When `GSV_INSTALL_DIR` is unset the
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

## Windows service and permissions

Connecting a Windows computer requests administrator approval to install the
`gsvd` SCM service. It starts at boot, reconnects when networking is available,
and keeps running through sign-out or Desktop exit. No interactive login is
needed to reach an enrolled server after reboot.

By default commands run as `NT SERVICE\gsvd`, a dedicated virtual account,
with read/write access to the selected workspace. The default is
`%USERPROFILE%\GSV`. Choose a folder whose permissions your user can change
without administrator elevation. Approval installs the boot service; it does not
grant agents extra access to protected application or system folders.
This identity does not inherit your personal SSH keys,
user-installed tools, mapped drives, or browser sessions. Configure credentials
and tools for the service account, or choose its Log On account in Windows
Services. Use UNC paths for network shares and grant that account access.
Reinstallation and upgrades preserve administrator-configured service settings,
including its account, startup mode, recovery policy and state-directory access.
A conflicting `gsvd`
registration must be resolved by an administrator before GSV can replace it.

The protected executable lives at `%ProgramFiles%\GSV\service\gsvd.exe`.
Daemon enrollment and logs live at `%ProgramData%\GSV\daemon`; CLI and Desktop
credentials stay in your profile. Only the enrolling user and administrators
can manage this service. One machine service has one enrolled owner; another
Windows user cannot silently replace it. `gsv daemon uninstall` stops and
removes the service and its workspace access grant while retaining enrollment,
logs, protected service binaries and workspace data. Removing GSV through Apps
also removes the user applications, shortcut and PATH entry. Saved service
state remains available for reinstall by the same owner.
Uninstall still removes the stopped service if its configuration is damaged or
workspace access cannot be revoked. It reports that the remaining workspace
grant needs manual removal. A fresh installation then uses the enrolling user's
configuration, even if the retained daemon configuration is damaged.

Windows automatic daemon updates are disabled. Rerun setup or the PowerShell
installer to update; it requests administrator approval for the existing boot
service and restores the previous binaries if the updated service cannot start. Desktop must be
closed before replacing its executables. There is no scheduled-task migration.
Setup authenticates its extracted installer script and release manifest against
hashes embedded in the setup executable before running them or requesting
service-update approval.

## Existing device daemon

On Unix, when the `gsvd` user service already exists, the installer:

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

On Linux and macOS, a connected machine keeps itself current. When the gateway is redeployed,
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
only updates itself when a service manager runs it (systemd or launchd), since something has to restart it afterwards; a
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

Start or focus the installed app with:

```bash
gsv desktop
```

`gsv desktop status`, `new`, and `use PID` use same-user local IPC. Desktop
connects to the gateway as a user; it does not route chat through `gsvd`.
The installer places `gsv-transcribe` and `gsv-vision` beside Desktop so it can
supervise the exact same-version helpers. The vision executable embeds its
checksum-pinned models; their Apache 2.0 license and provenance are installed
as verified sidecar assets.

Desktop uses the same Instrument source as the web UI. It is the only desktop
implementation shipped by releases. Launching opens the installed version;
rerun the installer to update it.

After signing in, choose Connect this computer to make it a target. Desktop
handles pairing and background service installation. Not now skips this step;
reopen it from the space menu under This computer. An existing connection for
the same space and account resumes automatically. Connections to another space
or account and your separate CLI login are preserved. The background service
continues after Desktop closes.

Linux requires WebKitGTK 4.1 and GStreamer base/good/libav plugins. On Arch:

```bash
sudo pacman -S --needed webkit2gtk-4.1 gst-plugins-base gst-plugins-good gst-libav
```

On Ubuntu/Debian:

```bash
sudo apt-get install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav
```

macOS releases also include `gsv-desktop-darwin-arm64.zip` and
`gsv-desktop-darwin-x64.zip`, each containing `GSV.app` with the CLI, daemon and
helpers. The developer app is ad-hoc signed and unnotarized. After the first
blocked launch, use System Settings → Privacy & Security → Open Anyway.
Replace the bundle to update it. Windows includes both local helpers; microphone
and camera access require an interactive session and permission in Windows
Privacy settings.
The Windows helpers use CPU inference. Local voice includes a baseline CPU backend
and automatically selects faster instructions when supported. AVX2 and AVX-512 are
optional. The installer and app bundle include the required speech libraries in
`gsv-transcribe-runtime` beside the helper; no separate installation or CPU setting
is needed. Keep that directory with the helper when moving a manual installation.
Gesture inference also selects supported CPU instructions at runtime.

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

From a source checkout, `python host/scripts/check-transcription.py` verifies
streaming speech inference against a pinned public recording without opening a
microphone. Its first run downloads the same verified model used by Desktop.

Windows release artifacts are unsigned unless the release runner has a signing
certificate configured. SmartScreen may show an unknown-publisher warning.
The installer still checks every GSV asset against the release manifest.
