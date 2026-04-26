# Hardware Tools Reference

GSV exposes a single hardware tool interface to AI processes. The same tool names are used for the native cloud target and for connected CLI devices; the `target` argument chooses where the syscall runs.

This is the important rule for agents: choose `target: "gsv"` for Gateway-native work, and choose a device target only when the file, command, network, or hardware dependency lives on that device.

## Targets

| Target | Description |
|---|---|
| `gsv` | Native Gateway target running in the Cloudflare Worker sandbox. |
| `<deviceId>` | A connected CLI device, such as `macbook` or `server`. |

The Gateway includes accessible online devices in `ai.tools` context and in `sys.device.list`. Devices also appear in the native filesystem under `/sys/devices`.

## Agent-Visible Tools

| Tool | Syscall | Description |
|---|---|---|
| `Read` | `fs.read` | Read a file or list a directory. |
| `Write` | `fs.write` | Write a complete file, creating parents where supported. |
| `Edit` | `fs.edit` | Replace exact text in a file. |
| `Delete` | `fs.delete` | Delete a file or directory. |
| `Search` | `fs.search` | Search file contents. |
| `Shell` | `shell.exec` | Execute a shell command. |

Each tool receives the same public argument shape regardless of target. For example:

```json
{
  "target": "gsv",
  "path": "/sys/devices"
}
```

```json
{
  "target": "macbook",
  "command": "git status --short",
  "workdir": "~/projects/gsv"
}
```

## Hardware Descriptors

CLI devices register with the Gateway as driver connections. A device descriptor records identity, online state, and implemented syscall patterns.

```json
{
  "deviceId": "macbook",
  "platform": "darwin",
  "version": "0.1.0",
  "online": true,
  "implements": ["fs.*", "shell.exec"]
}
```

The `implements` field is the hardware contract. The Gateway uses it to decide which devices can receive a given routed syscall.

Inspect descriptors with:

- `sys.device.list`
- `sys.device.get`
- `Read` with `target: "gsv"` and `path: "/sys/devices"`

## Native `gsv` Target

The `gsv` target runs inside the Gateway. Filesystem syscalls use `GsvFs`; shell syscalls use the native `just-bash` driver.

Important native paths:

- `/home` and the user's home directory contain durable user context.
- `/workspaces` contains task workspaces and user artifacts.
- `/etc` contains operator docs and system manuals.
- `/sys` exposes live kernel configuration, devices, users, and capabilities.
- `/proc` exposes process inspection surfaces.
- `/dev` exposes device-like virtual endpoints.

Native shell commands run in the Worker sandbox. They are useful for GSV control-plane work, virtual filesystem inspection, package commands, and HTTP/network operations allowed by the runtime. They do not run on the user's laptop.

## CLI Device Targets

CLI devices run on user machines through `gsv device run` or the managed device service. They implement the same `fs.*` and `shell.exec` interface over WebSocket.

Device filesystem semantics:

- Relative paths resolve against the configured device workspace.
- Absolute paths are used as-is on the device.
- Returned paths are local machine paths.
- Reads can return text, directory listings, or supported image content.

Device shell semantics:

- Unix devices run commands through the user's shell with `-lc`.
- Windows devices run commands through PowerShell.
- `command`, `workdir`, `timeout`, `background`, and `yieldMs` are supported.
- Long-running commands can return a background session while continuing on the device.

Use a device target for local source trees, private networks, machine-local credentials, OS packages, hardware access, or commands that must run on that machine.

## Routing

For `fs.*` and `shell.exec`, the Gateway reads `target` at dispatch time.

- `target: "gsv"` runs the native handler.
- `target: "<deviceId>"` verifies access, online state, and `implements`, then forwards the same syscall to the device.
- `target` is removed before native execution or device forwarding, so implementations receive the same syscall-specific arguments.

Other syscall domains such as `proc.*`, `pkg.*`, `knowledge.*`, `sys.*`, `notification.*`, `signal.*`, and `adapter.*` are kernel/control-plane interfaces and are not hardware-routed.

## Implementation References

- Tool schemas: `gateway/src/kernel/ai.ts`
- Target injection: `gateway/src/syscalls/index.ts`
- Routing: `gateway/src/kernel/dispatch.ts`
- Native filesystem: `gateway/src/drivers/native/fs.ts`
- Native shell: `gateway/src/drivers/native/shell.ts`
- Device registry: `gateway/src/kernel/devices.ts`
- CLI driver bridge: `cli/src/main.rs`
- CLI local tools: `cli/src/tools/`
