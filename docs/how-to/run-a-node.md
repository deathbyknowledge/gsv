# How to Run a Device

Devices are local machines that connect to the Kernel as driver processes. They
implement the same hardware syscall interface as the native `gsv` target,
usually `fs.*` and `shell.exec`.

## Create a Device Token

Device connections use token auth. If `gsv auth setup --node-id ...` already
issued a token, skip this step. Otherwise create one:

```bash
gsv auth token create --kind node --device macbook --label macbook
```

Save the returned raw token and device id in local CLI config on the device
machine:

```bash
gsv config --local set gateway.username admin
gsv config --local set node.id macbook
gsv config --local set node.token "<returned-token>"
```

If this machine was not used for deployment, also set the Gateway URL:

```bash
gsv config --local set gateway.url wss://gsv.<your-subdomain>.workers.dev/ws
```

## Run in the Foreground

Foreground mode is best for testing:

```bash
gsv device run --id macbook --workspace ~/projects
```

The device remains connected until the process exits. Relative file paths and
shell workdirs resolve from `--workspace`; absolute paths are used as-is on the
device.

## Install as a Service

For a persistent device daemon:

```bash
gsv device install --id macbook --workspace ~/projects
```

This installs a launchd agent on macOS or a systemd user unit on Linux and
starts it immediately.

Manage it with:

```bash
gsv device status
gsv device logs --follow
gsv device stop
gsv device start
```

Logs are written under `~/.gsv/logs/node.log`; the local config keys still use
`node.*` because they are the persisted driver fields.

## Use Devices From an Agent

Agents do not receive prefixed tools. They see the normal tools and choose a
target:

```json
{ "path": "README.md", "target": "gsv" }
```

```json
{ "command": "git status --short", "target": "macbook", "workdir": "~/projects/gsv" }
```

Use `target: "gsv"` for the cloud filesystem and Kernel-backed paths such as
`/home`, `/workspaces`, `/sys`, `/proc`, and `/usr/local/bin`. Use a device id
only when the file, network, credential, OS package, or hardware exists on that
machine.

## Run Multiple Devices

Each device needs a stable id and, preferably, a token bound to that id:

```bash
gsv auth token create --kind node --device laptop --label laptop
gsv auth token create --kind node --device server --label server
```

Then configure each machine locally:

```bash
gsv config --local set node.id server
gsv config --local set node.workspace /srv/app
gsv config --local set node.token "<server-token>"
gsv device install
```

The Kernel shows only accessible online devices to the process. Device routing
also checks owner/group ACLs and the device `implements` list before forwarding
a syscall.

## Security Notes

Device execution is not a sandbox. `shell.exec` runs as the OS user that started
`gsv device`, and file tools can use absolute paths. Run the daemon as an
unprivileged user, bind tokens to device ids, keep workspaces narrow, and revoke
tokens you no longer need:

```bash
gsv auth token list
gsv auth token revoke <token-id> --reason "rotated device credential"
```
