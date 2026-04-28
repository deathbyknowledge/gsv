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
| `CodeMode` | `codemode.exec` | Run a sandboxed JavaScript block that can call filesystem and shell tools programmatically. |

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
  "input": "git status --short",
  "cwd": "~/projects/gsv"
}
```

`Shell` uses one small public argument shape:

```ts
type ShellArgs = {
  target?: string;
  cwd?: string;
  input: string;
  sessionId?: string;
};
```

When `sessionId` is absent, `input` is a command to start. When
`sessionId` is present, `input` is stdin for that running command; use
`input: ""` to poll for more output without writing stdin. The runtime owns
the wait budget and output caps, so callers should handle both completed and
running results.

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

The native shell also includes a `codemode` command for reusable GSV tool
scripts:

```bash
codemode ./check.js --target macbook --cwd ~/projects/gsv --json
codemode run ./check.js --target macbook --cwd ~/projects/gsv --json
codemode -e 'return await shell("pwd")'
```

Scripts use the same CodeMode shape exposed to agents. A script is treated as
the body of an async function: top-level `await` works, and the final value must
be returned explicitly.

```js
const file = await fs.read({ path: "package.json" });
return { argv, args, bytes: file.content.length };
```

`--target` and `--cwd` become defaults for in-script `shell(...)` and `fs.*`
calls. Positional values after `--` are available as `argv`; `--arg key=value`
and `--args-json` populate `args`.

Without `--json`, `codemode` prints only the returned value. With `--json`, it
prints the full `{ status, result?, error?, logs? }` envelope. Failed runs exit
with code `1`.

Shell calls inside CodeMode return the same result shape as direct `Shell` tool
calls. Long-running commands must be resumed with `sessionId`:

```js
let res = await shell("npm run test", { target: "macbook", cwd: "~/projects/gsv" });
let output = res.output;

while (res.status === "running") {
  res = await shell("", { sessionId: res.sessionId });
  output += res.output;
}

if (res.status === "failed") {
  throw new Error(`${res.error}\n${output}`);
}

return { exitCode: res.exitCode, output };
```

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
- `input` starts a command; `cwd` selects its working directory.
- Long-running commands return a resumable `sessionId` instead of holding the original route open.
- `Shell` with `sessionId` and `input: ""` polls for more output.
- `Shell` with `sessionId` and non-empty `input` writes stdin, then returns new output.

Use a device target for local source trees, private networks, machine-local credentials, OS packages, hardware access, or commands that must run on that machine.

## Routing

For `fs.*` and `shell.exec`, the Gateway reads `target` at dispatch time.

- `target: "gsv"` runs the native handler.
- `target: "<deviceId>"` verifies access, online state, and `implements`, then forwards the same syscall to the device.
- `shell.exec` with `sessionId` routes through the persisted shell session owner; `target` is not required for continuation.
- `target` is removed before native execution or device forwarding, so implementations receive the same syscall-specific arguments.

Other syscall domains such as `proc.*`, `pkg.*`, `repo.*`, `sys.*`, `notification.*`, `signal.*`, and `adapter.*` are kernel/control-plane interfaces and are not hardware-routed.

`CodeMode` is process-local. It is not device-routed itself; code running inside
the sandbox calls `shell(...)` and `fs.*(...)`, and those nested calls use the
same `target` and `sessionId` routing rules as the direct `Shell`, `Read`,
`Write`, `Edit`, `Delete`, and `Search` tools.

## Implementation References

- Tool schemas: `gateway/src/kernel/ai.ts`
- Target injection: `gateway/src/syscalls/index.ts`
- Routing: `gateway/src/kernel/dispatch.ts`
- CodeMode runtime: `gateway/src/process/codemode.ts`
- Native filesystem: `gateway/src/drivers/native/fs.ts`
- Native shell: `gateway/src/drivers/native/shell.ts`
- Device registry: `gateway/src/kernel/devices.ts`
- CLI driver bridge: `cli/src/main.rs`
- CLI local tools: `cli/src/tools/`
