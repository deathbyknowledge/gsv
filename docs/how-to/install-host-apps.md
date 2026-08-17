# Install and upgrade GSV host applications

The GSV release is one versioned host distribution. The operator CLI (`gsv`),
machine daemon (`gsvd`), Desktop, and Desktop transcription helper share the
version in the repository root `VERSION` file. The CLI refuses to manage a
mismatched daemon.

## Supported release artifacts

| Platform | `gsv` | `gsvd` | Desktop | Transcription |
| --- | --- | --- | --- | --- |
| Linux x64 | yes | yes | yes | yes |
| Linux ARM64 | yes | yes | yes | yes |
| macOS Intel | yes | yes | yes | yes |
| macOS Apple Silicon | yes | yes | yes | yes |
| Windows x64 | yes | yes | not yet | not yet |

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
`GSV_VERSION=vX.Y.Z` to install an immutable release tag. `GSV_INSTALL_DIR`
overrides the destination. The default is `/usr/local/bin` on Linux and macOS,
and `%LOCALAPPDATA%\Programs\gsv\bin` on Windows.

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
enrolled; run `gsv device install` after configuring a driver credential.

## Desktop

On Linux and macOS, start or focus the installed app with:

```bash
gsv desktop
```

`gsv desktop status`, `new`, and `use PID` use same-user local IPC. Desktop
connects to the gateway as a user; it does not route chat through `gsvd`.

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

After installing the device service, inspect it with:

```bash
gsv device doctor
gsv device status
```
