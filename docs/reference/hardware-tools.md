# Hardware Tools Reference

GSV exposes a single hardware tool interface to AI processes. The same tool names are used for the native cloud target and for connected CLI devices; the `target` argument chooses where the syscall runs.

This is the important rule for agents: choose `target: "gsv"` for Gateway-native work, and choose a device target only when the file, command, network, or hardware dependency lives on that device.

## Targets

| Target | Description |
|---|---|
| `gsv` | Native Gateway target running in the Cloudflare Worker sandbox. |
| `<deviceId>` | A registered CLI device, such as `macbook` or `server`; routable while online. |

The Gateway includes accessible online devices in `ai.tools` context and, by default, in `sys.device.list`. Those inventories advertise devices that can accept work immediately. The agent-facing `targets list` command includes every visible registered device by default and labels each one `online` or `offline`; use `targets list --online` to restrict it to reachable targets. Device notes are included too, so processes can identify machines using the user's own descriptions. Registered devices also appear in the native filesystem under `/sys/devices`.

Messaging adapters are not hardware targets and never appear in these
inventories. Use `message destinations` to discover authorized external chat
surfaces; use adapter APIs or the Messengers console to inspect and administer
the underlying accounts.

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

The native shell is self-describing. When a request does not map to an obvious
tool, search using the user's goal instead of guessing a command name:

```bash
man --search -- 'put the image from this chat on my laptop'
man -k 'run this every weekday morning'
```

Results are ranked across caller-visible native commands, skills,
targets, and ready MCP integrations. Each row includes an exact `NEXT` action.
Use `man <command>` after discovery for command-specific guidance.

## Hardware Descriptors

CLI devices register with the Gateway as driver connections. A device descriptor records identity, online state, and implemented syscall patterns.

```json
{
  "deviceId": "macbook",
  "description": "Personal MacBook I use for everything",
  "platform": "darwin",
  "version": "0.1.0",
  "online": true,
  "implements": ["fs.*", "shell.exec", "net.fetch"]
}
```

The `implements` field is the hardware contract. The Gateway uses it to decide which devices can receive a given routed syscall. The `description` field is owner-managed context for users and processes; it is not supplied by the driver connection.

Inspect descriptors with:

- `sys.device.list`
- `sys.device.get`
- `sys.device.update` to change the owner-managed `description`
- `sys.device.delete` to forget an owned physical device, disconnect any live device socket, and revoke device-bound node tokens
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

Native shell commands run in the Worker sandbox. They are useful for GSV control-plane work, virtual filesystem inspection, and HTTP/network operations allowed by the runtime. They do not run on the user's laptop.

`man --search` includes reusable process workflows populated from layered
`skills.d` directories. Its `NEXT` action opens matching workflows with
`skills show <skill>`; the specialized `skills list`, `skills search`, and
`skills tree` commands remain available for direct inspection. `skills create`
persists a complete reusable workflow in the current program's home and
`skills validate` checks its frontmatter, path name, and instruction body.

The native shell also includes a `codemode` command for reusable GSV tool
scripts and an `mcp` command for connected MCP servers:

```bash
codemode ./check.js --target macbook --cwd ~/projects/gsv --json
codemode run ./check.js --target macbook --cwd ~/projects/gsv --json
codemode -e 'return await shell("pwd")'
mcp status
mcp tools Linear
mcp describe Linear list_issues
mcp codemode
mcp call Linear list_issues --args-json '{"assignee":"me","limit":5}' --json
```

Scripts use the same CodeMode shape exposed to agents. A script is treated as
the body of an async function: top-level `await` works, and the final value must
be returned explicitly.

```js
const file = await fs.read({ path: "package.json" });
const result = await lookup_record({ query: "gsv" });
return { argv, args, bytes: file.content.length, result };
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

MCP tools inside CodeMode are generated as async functions from the connected
server schemas. A unique tool such as `lookup-record` becomes
`lookup_record(args)`; each tool also gets a server-qualified alias such as
`Search_lookup_record(args)` for clarity and collision handling. The fixed
CodeMode tool description shows how to discover these functions on demand. The
`mcpTools` array lists the generated function names, server ids, original tool
names, input schemas, and output schemas.
Generated functions unwrap MCP result envelopes: structured content is returned
directly, text-only content is parsed as JSON when possible or returned as a
string, and MCP tool errors throw. Server management remains available from the
native shell as `mcp status`, `mcp tools`, `mcp describe`, `mcp search`,
`mcp codemode`, `mcp refresh`, and `mcp call`. The shell command accepts either
server ids or unique server names, and tool selectors may use either the
original MCP tool name or the generated CodeMode function name.

## CLI Device Targets

The `gsvd` machine daemon runs on user machines directly or through the managed
per-user service. `gsv daemon` installs and controls that service; the hidden
`gsv device run` command remains only for old installed service definitions.
The daemon implements the same `fs.*`, `shell.exec`, and `net.fetch` interface
over WebSocket.

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

## Android Wear Targets

The Android application registers as an ordinary driver target with:

```json
{
  "implements": ["fs.*", "shell.exec", "net.fetch"]
}
```

It presents app-private Android storage, runtime inspection, and physical
sensors through one bounded virtual target. Filesystem tools use the same
public syscall shapes as other targets:

- `/home/android` is persistent across runtime restarts and app upgrades.
- `/tmp` lasts for one service runtime and is cleared on startup and shutdown.
- `/proc/device.json`, `/proc/capabilities.json`, and `/proc/runtime.json`
  describe the phone and target runtime.
- `/proc/wear/status.json` and `/dev/wear/status` report Wear authority and
  sensor state.
- `/dev/camera/back/snapshot` is an event-producing image file.
- On GSV OS, `/dev/screen/screenshot` is an event-producing PNG image file.

Only `/home/android` and `/tmp` are writable. A file is limited to 64 MiB,
persistent target storage to 256 MiB, temporary storage to 128 MiB, and each
mount to 4,096 entries. Direct text reads and edits are limited to 8 MiB;
larger files remain transferable as binary bodies. These are target policy
limits, not access to the phone's shared storage or Android filesystem.

The shell uses that same virtual filesystem. Run `help` or `commands --json`
to discover its bounded commands. It supports quoting, pipelines, sequential
statements, input/output redirection, common file and text commands, and the
Android-specific `wear`, camera, microphone, IMU, gesture, orientation,
location, device-context, notification, app/deep-link, share, clipboard,
text-to-speech, vibration, and local-check commands. GSV OS targets additionally
expose bounded `screen` and `input` commands through their platform service. It
does not invoke `/system/bin/sh` or Android system binaries. Shell sessions and
background commands are not supported.

`net.fetch` executes an HTTP(S) request on the phone and streams the response
through the ordinary target body protocol. Request and response bodies are
limited to 32 MiB. Redirect policy, timeout, cancellation, body-length checks,
and response-temp cleanup are owned by the Android network handler.

Wear status and one-shot camera capture remain standardized virtual files, so
agents use the fixed `Read` tool instead of receiving a camera-specific model
tool. Timed sensor sessions compose beneath the fixed `Shell` tool:

```json
{
  "target": "pixel-10",
  "path": "/dev/wear/status"
}
```

```json
{
  "target": "pixel-10",
  "path": "/dev/camera/back/snapshot"
}
```

`/dev/wear/status` is readable whenever the Android runtime is connected and
returns the connection, authority, and sensor states. The snapshot node is
available only during a locally created, currently armed Wear authority
session. Reading it opens CameraX for one bounded capture, returns an ordinary
`fs.read` image body, closes the camera, and deletes the temporary JPEG after
the body reaches a terminal outcome. Offset and limit arguments are rejected
for event-producing virtual files.

To retain or transfer a capture, materialize it once inside the target:

```bash
camera snapshot /tmp/current-context.jpg
```

The resulting ordinary file can be read repeatedly or copied between `gsv`,
Android, and another device using the standard `fs.copy` transfer path. Binary
request and response bodies are streamed through protocol frames, checked
against their declared length, bounded to 64 MiB, and removed from the Android
incoming spool at every terminal outcome.

Timed physical-context commands are bounded to two minutes. Camera observation
materializes JPEG frames and a manifest. Microphone capture materializes WAV
audio and JSON analysis; its on-device primitive detector recognizes
speech-or-voice, loud sound, and sustained tone, and labels other requested
events as requiring semantic inference. IMU and gesture sessions summarize
motion, shake events, and orientation without exposing Android sensor APIs as
a second protocol.

Device commands expose battery, active network, thermal/power, target storage,
granted runtime permissions, location, launcher apps, and optional notification
listener data. Agent output commands can show notifications, speak, and
vibrate. App opening, deep links, and sharing obey Android's background-activity
rules: a screen-off/background request returns `requiresUserTap: true` and
posts an actionable notification. Clipboard reads report unavailable unless
GSV Wear is visible.

The GSV OS platform service closes the visual-control loop without changing the
public target protocol. `screen screenshot` materializes a bounded PNG with
secure and protected layers redacted; `apps foreground` reports the current
activity; `apps open` launches a launcher application directly; and `input`
supports tap, swipe, long-press, an explicit safe key allowlist, and bounded
virtual-keyboard text. These operations require a locally armed Wear authority
for their complete execution. The service is signature-protected, runs in a
dedicated SELinux domain without network access, and is unavailable to ordinary
APK installations, which retain Android's notification-mediated app opening.

`checks` persists up to 32 bounded sensor/context commands and schedules them
inside the armed foreground runtime. Checks continue across temporary Gateway
disconnects, journal results beneath `/home/android/checks`, and are cancelled
by pause, disarm, removal, or service teardown. They do not constitute an
offline agent runtime or replay remote requests.

Disarming removes sensor authority but deliberately leaves the driver
connection, filesystem, and bounded shell running. Disconnecting the Android
runtime is a separate local action. A remote caller cannot arm Wear Mode or
change its desired state. When the user has armed or paused Wear Mode locally,
the app persists that choice and may create a fresh authority generation after
process death, package replacement, or the first credential unlock after
reboot. Required credential or permission loss clears the desired state;
Android force-stop suppresses restoration until the user launches the package
again. GSV OS additionally supervises the platform-signed app as a persistent
process and exempts its explicitly armed runtime from Doze and Data Saver.

## Routing

For `fs.*`, `shell.exec`, and `net.fetch`, the Gateway reads `target` at
dispatch time.

- `target: "gsv"` runs the native handler.
- `target: "<deviceId>"` verifies access, online state, and `implements`, then forwards the same syscall to the device.
- `shell.exec` with `sessionId` routes through the persisted shell session owner; `target` is not required for continuation.
- `target` is removed before native execution or device forwarding, so implementations receive the same syscall-specific arguments.

Other syscall domains such as `proc.*`, `repo.*`, `sys.*`, `signal.*`, and `adapter.*` are kernel/control-plane interfaces and are not hardware-routed.

`CodeMode` is process-local. It is not device-routed itself; code running inside
the sandbox calls `shell(...)`, `fs.*(...)`, and `fetch(...)`; those nested
calls use the same target-routing rules as direct model tools.

## Implementation References

- Tool schemas: `gateway/src/kernel/ai.ts`
- Target injection: `gateway/src/syscalls/index.ts`
- Routing: `gateway/src/kernel/dispatch.ts`
- CodeMode runtime: `gateway/src/process/codemode.ts`
- Native filesystem: `gateway/src/drivers/native/fs.ts`
- Native shell: `gateway/src/drivers/native/shell.ts`
- Device registry: `gateway/src/kernel/devices.ts`
- CLI driver bridge: `host/apps/cli/src/main.rs`
- Machine tools: `host/apps/machine/src/tools/`

## See also

- [Connect Devices](../how-to/connect-devices)
- [Routing Reference](./routing.md)
- [Architecture Overview](../architecture/)
