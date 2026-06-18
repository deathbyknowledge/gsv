# Target Tools Reference

GSV exposes one targetable tool interface to AI processes. The same tool names are used for the native cloud target, connected devices, extension-provided browser targets, and adapter command targets; the `target` argument chooses where the syscall runs.

This is the important rule for agents: choose `target: "gsv"` for Gateway-native work, and choose a device target only when the file, command, network, or hardware dependency lives on that device.

## Targets

| Target | Description |
|---|---|
| `gsv` | Native Gateway target running in the Cloudflare Worker sandbox. |
| `<deviceId>` | A connected native device, such as `macbook` or `server`. |
| browser target id | An active browser target registered by the browser extension, such as `browser:chrome` or `rearden:brave`. |
| `adapter:<adapter>:<account>` | An adapter command target, such as WhatsApp or Discord. |

The prompt includes a compact sample of accessible online targets. Use `targets list` in the native shell for paginated discovery, or `targets show <target-id>` for details. The lower-level syscall surface is still `sys.device.list`/`sys.device.get`, and device-like entries also appear in the native filesystem under `/sys/devices`.

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

## Target Descriptors

Native devices register with the Gateway as driver connections. Browser extension targets and adapter accounts are normalized into the same target descriptor model. A descriptor records identity, online state, and implemented syscall patterns.

```json
{
  "deviceId": "macbook",
  "description": "Personal MacBook I use for everything",
  "platform": "darwin",
  "version": "0.1.0",
  "online": true,
  "implements": ["fs.*", "shell.exec"]
}
```

The `implements` field is the hardware contract. The Gateway uses it to decide which devices can receive a given routed syscall. The `description` field is owner-managed context for users and processes; it is not supplied by the driver connection.

Inspect descriptors with:

- `targets list`
- `targets show <target-id>`
- `sys.device.list`
- `sys.device.get`
- `sys.device.update` to change the owner-managed `description`
- `Read` with `target: "gsv"` and `path: "/sys/devices"`

## Native `gsv` Target

The `gsv` target runs inside the Gateway. Filesystem syscalls use `GsvFs`; shell syscalls use the native `just-bash` driver.

Important native paths:

- `/home` and the user's home directory contain durable user context.
- `/etc` contains operator docs and system manuals.
- `/sys` exposes live kernel configuration, devices, users, and capabilities.
- `/proc` exposes process inspection surfaces.
- `/dev` exposes device-like virtual endpoints.

Native shell commands run in the Worker sandbox. They are useful for GSV control-plane work, virtual filesystem inspection, package commands, and HTTP/network operations allowed by the runtime. They do not run on the user's laptop.

Use `skills list`, `skills list <skill>`, `skills search <query>`, and
`skills show <skill>` in the native shell to inspect reusable process workflows
populated from layered `skills.d` directories.

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

Process and automation control also stay on the native shell surface:

```bash
proc agents
proc spawn --as friday --label "docs audit"
proc call <pid> --timeout 60s "Summarize the current result."
crontab -l
printf '0 4 * * * proc compact init:1000 --conversation default --keep-last 80 --generate-summary\n' > /var/spool/cron/sam
printf '0 9 * * * proc spawn --as friday --non-interactive --label daily-brief "Prepare the daily brief."\n' > ~/daily.cron && crontab ~/daily.cron
```

Use `proc agents` to discover accounts you can run processes as: your own
account, your personal agent, and enabled package agents. Agent prompt context
lives in that account's `~/context.d/*.md` files. Replace `friday` with the
agent account username listed for your install.
`proc call` is the bounded request/reply path; `proc spawn --prompt` and `proc
send` are fire-and-forget unless the worker explicitly sends a later message.
Cron jobs run shell commands from `/var/spool/cron/<user>` or `/etc/cron.d/*`.
Use `proc compact`, `proc spawn --non-interactive`, or `proc send` directly in
those files.

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
`Search_lookup_record(args)` for clarity and collision handling. The CodeMode
tool description includes generated TypeScript declarations for ready MCP tools
when their schemas are known. The `mcpTools` array lists the generated function
names, server ids, original tool names, input schemas, and output schemas.
Generated functions unwrap MCP result envelopes: structured content is returned
directly, text-only content is parsed as JSON when possible or returned as a
string, and MCP tool errors throw. Server management remains available from the
native shell as `mcp status`, `mcp tools`, `mcp describe`, `mcp search`,
`mcp codemode`, `mcp refresh`, and `mcp call`. The shell command accepts either
server ids or unique server names, and tool selectors may use either the
original MCP tool name or the generated CodeMode function name.

## Browser Extension Targets

Browser targets are active browser profiles connected by the GSV browser
extension. They use the same targetable `Shell` and `fs.*` tools as native
devices, with the target id selecting which browser profile receives the call.

Browser target ids are configured by the extension. They may start with
`browser:` or use a host/browser shape such as `rearden:brave`. Because many
browser target ids contain `:`, bracket them in target-qualified file paths:

```bash
cp [rearden:brave]:/home/browser/screenshots/tab-123.png gsv:/home/alice/tab-123.png
cp gsv:/home/alice/input.json [rearden:brave]:/tmp/input.json
```

Run target-qualified `cp` from the native GSV shell or target-aware filesystem
tools. The browser target's just-bash `cp` is local to the browser filesystem.

Use the native `gsv` target to discover and inspect browser targets:

```bash
targets list --kind browser
targets show rearden:brave
```

Then use `Shell` with `target` set to the browser target and inspect the target's
own help before acting:

```bash
cat /README.txt
help
tabs --help
page --help
network --help
media --help
```

Current extension targets expose browser commands for tabs, windows, page
snapshots/text/screenshots/clicks/typing/keyboard/scroll/wait/JavaScript,
clipboard, cookies, `chrome.storage.local`, downloads, history, bookmarks, and
network capture. Newer extension targets can also record tab audio/video and open
URLs, browser-local files, or stdin in viewer tabs through
`tabs open [--mime type] <url|path|->`. The exact command set
depends on extension version and browser permissions, so `/README.txt`, `help`,
and `<command> --help` are authoritative.

For reusable operating guidance, run `skills show browser-target`.

Useful runtime paths include:

- `/README.txt`
- `/proc/browser.json`
- `/proc/tabs.json`
- `/proc/tabs/<tabId>/meta.json`
- `/proc/tabs/<tabId>/text.txt`
- `/proc/network/status.json`
- `/proc/network/events.jsonl`
- `/proc/network/requests.json`

Writable browser-local paths usually include `/tmp`, `/tmp/render`,
`/home/browser`, `/home/browser/screenshots`, `/home/browser/network`, and
`/home/browser/recordings`. Network captures started with
`network start --persist` write session artifacts under
`/home/browser/network/sessions/...`; tab media recordings write under
`/home/browser/recordings` unless another path is requested. Use
`media record start --video` or `--mode video` for video capture. Chrome may
require the user to focus the tab and click Grant Recording in the extension UI
before recording starts; each grant can start one recording.

## CLI Device Targets

CLI devices run on user machines through `gsv device run` or the managed node daemon service. They implement the same `fs.*` and `shell.exec` interface over WebSocket.

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
