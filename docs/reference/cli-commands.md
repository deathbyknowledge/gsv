# CLI Command Reference

The `gsv` binary controls a GSV gateway, local Desktop application, device
daemon, process tree, adapters, and Cloudflare infrastructure. Most commands
talk to the Kernel syscall surface over WebSocket; `desktop` uses a same-user
local endpoint and `infra` talks directly to Cloudflare.

## Global Options

`--url` is a top-level option, so place it before the subcommand:

```bash
gsv --url wss://example.workers.dev/ws chat "hello"
```

| Option | Env | Description |
| --- | --- | --- |
| `--url <URL>` | `GSV_URL` | Gateway WebSocket URL. Defaults to `gateway.url` in local config, then `ws://localhost:8787/ws`. |
| `-u, --user <USER>` | | Gateway username override. |
| `-p, --password <PASS>` | | Password for non-interactive login/setup. |
| `-t, --token <TOKEN>` | `GSV_TOKEN` | Non-interactive credential. User commands require a username with token auth. |

Local CLI config is stored at `~/.config/gsv/config.toml`. Remote user commands use
the cached session token from `gsv auth login`, or prompt/login when needed.

## Chat and Shell

```bash
gsv chat [MESSAGE] [--pid PID]
gsv shell
```

`chat` resolves the Ship or selected Work conversation and sends with
`conversation.send`. With `MESSAGE`, it waits for the canonical
`message.committed` and matching `proc.run.finished` signals for up to 120
seconds. The
interactive prompt returns after each message is accepted so another message
can supersede an active run; type `quit` or `exit` to leave. `--pid` targets a
specific process; when omitted, the CLI uses the user's personal
intelligence process. Set `GSV_CLIENT_DEBUG=1` to trace run-signal matching.

`shell` opens an interactive prompt backed by the gateway `shell.exec` syscall.
Commands run inside the gateway OS context, not directly on your local machine.
Use `:quit`, `:exit`, or `:q` to leave.

Inside the gateway shell, `proc` is the process IPC userland command.
`message` inspects and uses external chat reply routes. `sched add --ship`
creates recurring or one-shot Ship responsibilities; `sched add --here`
targets the resolved current Process and uses the same responsibility semantics
when that Process is Ship.
`crontab` schedules background shell commands, while the remaining `sched`
commands inspect and control the Kernel schedule records:

```bash
proc self
proc list
proc spawn [--as ACCOUNT] [--non-interactive] [--label LABEL] [--prompt TEXT] [--] [prompt]
proc delegate [--as ACCOUNT] [--label LABEL] [--timeout 10m] [--responsibility ID] <task>
proc reset [--pid PID]
proc kill PID [--no-archive]
proc send <pid> [--metadata-json json] <message>
proc call <pid> [--metadata-json json] [--timeout 60s] <message>
message current [--json]
message destinations [--all] [--json]
message route show [--to here|DESTINATION] [--json]
message route list [--json]
message route set --process PID_OR_LABEL [--to here|DESTINATION] [--json]
message route clear [--to here|DESTINATION] [--json]
message attach PATH... [--mime TYPE]
message history --with CONTACT_OR_CONVERSATION [--before SEQUENCE] [--limit N] [--json]
message delivery show DELIVERY_ID [--json]
message send [--message TEXT]
yield
message send --to DESTINATION [--message TEXT] [--attach PATH [--mime TYPE]] [--delivery-id ID] [--also]
contact identity
contact list [--all] [--json]
contact alias CONTACT_ID NAME|--clear
contact invite create [--expires DURATION]
contact invite accept CODE
contact invite list [--all] [--json]
contact invite cancel INVITE_ID
contact revoke CONTACT_ID
contact request list [--contact CONTACT_ID] [--all] [--json]
contact request create --contact CONTACT_ID --kind KIND --title TITLE [--details JSON] [--delivery-id ID]
contact request update REQUEST_ID --state STATE [--revision N] [--details JSON] [--delivery-id ID]
r12y list [--all] [--json]
r12y show ID
r12y create --title TITLE [--details JSON] [--parent ID] [--priority PRIORITY] [--due ISO] [--check ISO] [--blocker TEXT] [--dedupe KEY]
r12y update ID --json PATCH
r12y start ID
r12y wait ID [--until ISO] [--blocker TEXT]
r12y delegate ID PID --until ISO
r12y resolve ID [--json RESOLUTION]
r12y cancel ID [--json RESOLUTION]
r12y sources
r12y source enable|disable SOURCE_ID
img2txt [caption] [--length short|normal|long] [--stream] IMAGE
img2txt query --prompt TEXT [--reasoning] [--response-format FORMAT] [--schema JSON] [--stream] IMAGE
img2txt ocr [--prompt TEXT] [--response-format FORMAT] [--schema JSON] [--stream] IMAGE
img2txt point --target TEXT [--max-objects N] IMAGE
img2txt detect --target TEXT [--max-objects N] IMAGE
crontab -l
crontab FILE
crontab -r
sched list [--all]
sched add --ship --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE
sched add --here --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE
sched add --to DESTINATION --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE
sched add --json JSON
sched enable <id>
sched disable <id>
sched remove <id>
sched run <id> [--force]
```

`proc spawn` always creates a fresh process. A parentless spawn defaults to the
owner's personal agent, and a child inherits its parent unless `--as` selects
another owned agent account. Its prompt is fire-and-forget, and any answer
remains in that child process's history. Unknown options are
rejected; use `--` before a positional prompt that begins with `-`. Use
`--non-interactive` for scheduled background work. `proc delegate` creates a
bounded child whose ordinary final assistant output returns to its caller as a process event; it
requires a process-backed caller and must not be placed in a crontab. Passing
`--responsibility ID` assigns that existing Kernel record to the child before
IPC admission and restores its prior Ship state if admission fails. Completion,
failure, timeout, or kill returns a still-active assignment to Ship exactly once;
the IPC event carries the child result and the responsibility retains stable call
and run references.
`proc send` is asynchronous same-owner process mail. `proc call` is bounded:
the source process receives either
`ipc.reply` or `ipc.timeout` as a delegated task event. In a process-backed
shell, `proc self` prints the current process id and the shell exports it as
`GSV_PID`; a top-level user shell has no current process, so `proc self` exits
with an error there. `proc list` labels the one canonical process as
`kind=personal`; all other entries are `kind=work`, even when they run as the
same personal-agent account.

`r12y` manages the Kernel's durable unresolved-work ledger. `list` omits
terminal records unless `--all` is supplied. Waiting work must name a future
check time or a blocker. Prefer `proc delegate --responsibility ID ...` for a
new bounded worker; the lower-level `r12y delegate ID PID --until ISO` command
assigns an already-existing owned process with an explicit recovery deadline.
`r12y sources` lists required runtime contracts as `always-on` and configurable
producers as `configurable`. Only configurable producers can be changed. Use
`r12y source disable mail.received` to keep accepting mail without creating a
Ship responsibility for each message; enabling it affects future completions.
Other configurable sources cover federation ingress, new contacts, new machines,
connected adapters, and adapter authentication loss.

`message current` reports the current run's directed endpoint. For an adapter
run, both text and JSON output include an opaque
destination id suitable for a later `message send --to`; raw provider ids stay
hidden. `message attach` adds one or more GSV filesystem files to the run's
next current-conversation message; it does not create an extra message. Existing files
in the current process's `/var/media` directory
are reused, while other readable files are staged there. A direct Shell call using a literal block
sends a message and leaves the run active:

```bash
message send <<'GSV_MESSAGE'
your user-visible response
GSV_MESSAGE
```

Run `yield` when the work is complete. A final message can commit and yield without another model
turn by placing `&& yield` after the block declaration. The Process recognizes these message and
run-control commands without shell approval. During an active run,
`message send --to ... --also` creates an
additional outbound message or sends to another authorized destination.
`message destinations` lists observed destinations that are online; `--all`
also includes known authorized destinations whose adapter account is offline.
Group, channel, and thread entries appear only after the linked actor addresses
GSV on that exact surface. Entries use opaque GSV ids and generic labels;
provider account, actor, surface, and message ids are not printed.

`message route show` and `message route list` inspect adapter routing. `route
set` and `route clear` manage persistent mappings for groups, channels, and
threads. On a private DM, only the canonical personal process can use `route
set`, only from the exact latest inbound run on that DM, and only to an owned
interactive non-personal process. The human uses `/ship` inside the messaging
app to return to personal intelligence; `route clear` does not clear a DM.
`--to` defaults to `here` during an adapter-originated run; elsewhere, pass an
opaque destination id or unambiguous label from `message destinations --all`.
`route set` accepts a full or unique process-id prefix or an unambiguous process
label. A route change controls future inbound messages only, so the run making
the change keeps its direct messages routed to the conversation that started it.
Repeated `route set` calls from the same current run to the same work process
are idempotent. Newer private activity or a newer selection fences a late call.

`img2txt` uses Moondream 3.1 as its only image reader. With no subcommand it
returns a normal caption. `query` requires the caller's prompt; there is no
system query prompt. `ocr` has an extraction-specific default and accepts an
optional caller prompt. `point` returns normalized `{x, y}` coordinates and
`detect` returns normalized bounding boxes. Those two modes print JSON by
default.

`IMAGE` accepts the same target-qualified source forms as `cp`: a local path,
`gsv:/path`, `target:/path`, or `[target-with-colons]:/path`. A target image is
streamed directly through the filesystem transfer boundary into image reading;
the command does not stage a temporary GSV copy.

Query and OCR structured output accepts `text`, `json`, `xml`, `markdown`, or
`csv`. A JSON `--schema` is added to the caller's instruction, then the result
is parsed and checked before being returned. `--reasoning` exposes query
reasoning and grounding in the `--json` result envelope. `--stream` is
available for caption, query, and OCR, and cannot be combined with `--json`,
reasoning, or structured output. The underlying `ai.image.read` response body
streams decoded UTF-8 chunks; the gateway shell collects those chunks into its
final `shell.exec` stdout.

`--to here` selects the current adapter endpoint. Any explicit destination send during an active
run requires `--also`, acknowledging that it is intentionally sent to an explicit destination.
`--attach` streams one GSV filesystem
file; `--mime` overrides the inferred MIME type. Copy a file from a connected
target to GSV before attaching it:

```bash
cp laptop:/home/alice/report.pdf /tmp/report.pdf
message attach /tmp/report.pdf
message send --message "Here is the report." && yield
message send --to here --message "Here is the report." --attach /tmp/report.pdf --also
```

`message send` allocates a stable delivery id before contacting an adapter and
retries one transport failure with that same id. If delivery still cannot be
confirmed, its error includes the id; pass it back with `--delivery-id` to
reconcile without creating a second logical message. Attachment-open failures
also report that id, including a failure while reopening the file for the
automatic retry. An outcome that may have reached the provider is reported as
`sent=false`, `delivery_confirmed=false`, and `delivery_state=ambiguous`.

`contact` manages relationships with people on other GSV installations.
`contact invite create` produces a short-lived one-use code; the other person
accepts that code while signed in to their own GSV. Pairing and revocation may
be performed by the signed-in human or their canonical Ship. `contact list` prints the opaque contact id accepted
by `message send --to`; `message destinations` exposes the same active contacts
alongside messaging endpoints. `contact alias` changes only the local display
name; the remote Ship's authenticated identity remains visible and unchanged.

`contact invite list --all` exposes retained invitation lifecycle metadata but
never a recoverable code. `message history --with contact:...` reads the Contact
conversation. A Contact send reports durable local acceptance separately from
remote confirmation; use `message delivery show` with its delivery id.

Use `contact request create` and `contact request update` when the exchange has
a durable lifecycle rather than being only a message. Request revisions prevent
a stale client from overwriting a newer decision. Resources attached with
`message send --to contact:...` remain immutable references and are streamed by
the receiving GSV only when opened.

Use `sched add --ship` when every firing should become one durable Ship
responsibility. It works from top-level and process-backed shells. Use
`sched add --here` when the schedule should follow the resolved current Process.
For Ship, `--here` has exactly the same responsibility semantics as `--ship`,
even during an adapter run: future work is not bound to that run's destination.
A non-Ship target uses `process.event` and must be recreated after that Process
is killed.

Use `sched add --to DESTINATION` for direct scheduled text delivery. It creates
an `adapter.send` scheduled action and does not run the agent. Destination
resolution includes known authorized offline destinations because the account
may be online when the schedule fires. Run `message destinations --all` and
copy its opaque GSV destination id; provider account, actor, and surface ids are
not part of the agent-facing command contract.
A successful `responsibility` firing records durable responsibility creation, not
completion of its work. A successful `process.event` firing records event admission,
not completion of a model turn or reply. Choose exactly one time expression. `--at`
requires a future ISO timestamp with `Z` or an explicit numeric UTC offset.

```bash
sched add --ship --name animal-facts --every 2m --message "Send one obscure animal fact."
sched add --ship --name daily-brief --cron "0 9 * * *" --timezone Europe/Amsterdam --message "Prepare the daily brief."
sched add --to MESSAGE_DESTINATION_ID --name standup --cron "0 9 * * 1-5" --message "Standup starts now."
```

Use `crontab FILE` or write `/var/spool/cron/<user>` for recurring background
shell-command automation. A cron command has no process-backed caller. If it
starts an agent process, use `proc spawn --non-interactive` and do not expect its
answer to appear in a chat:

```cron
0 9 * * * proc spawn --non-interactive --label refresh-index "Refresh the search index."
```

The crontab file is the desired state: reinstalling it deletes and recreates the
linked Kernel schedule rows, so crontab-backed `sched` ids are not stable. Use
`sched list` to inspect next fire time, last status, error, source, and target.
For a command that invokes `proc spawn`, status `ok` means the command was
dispatched and the spawn was accepted; it does not mean the child finished or
delivered output. `sched list --all` includes disabled schedules; it does not
mean all users. `sched add --json` is a low-level compatibility path for direct
`sched.*` payloads.

## Process Commands

```bash
gsv proc list [--uid UID]
gsv proc spawn [--as ACCOUNT] [--label LABEL] [--prompt TEXT] [--parent PID]
gsv proc send MESSAGE --pid PID
gsv proc history --pid PID [--limit N] [--offset N]
gsv proc reset --pid PID
gsv proc kill PID [--no-archive]
```

Processes are the agent-facing execution model. `spawn` creates a new process;
`send` only reports acceptance, while `chat` waits for streamed output.
`send`, `history`, `reset`, and `kill` require a PID. `--uid` filters process
lists and requires root when viewing another user.

## Desktop Commands

```bash
gsv desktop
gsv desktop status [--json]
gsv desktop new
gsv desktop use PID
gsv desktop microphone list
gsv desktop microphone use NAME
gsv desktop microphone default
```

`gsv desktop` focuses a running Desktop or launches the sibling
`gsv-desktop` executable and waits for its local control endpoint. `new` also
launches or focuses Desktop, asks Desktop to create a Process using its own
authenticated gateway connection, selects it after authoritative history is
installed, and prints the new PID. A cancellation after durable spawn but
before selection can leave that Process valid but unselected. `use` launches
or focuses Desktop, validates and selects an existing
Process, then prints its PID.

The microphone commands query a running Desktop without focusing its window. If
Desktop is absent, they launch it and retry the requested microphone operation
while its local endpoint starts. `microphone list` lists at most 32 available
input devices and marks the operating-system default, the saved selection, and
any active `GSV_VOICE_DEVICE` environment override. That legacy override uses a
case-insensitive exact name, or a case-insensitive substring only when it
identifies one device unambiguously. If the environment value is empty, too
long, or otherwise invalid, output reports `environment override: invalid
(remove GSV_VOICE_DEVICE)` without echoing the value. A selection of `not
configured` means Desktop will ask on first voice use; `system default` means
that choice was made explicitly. `microphone use NAME` validates and saves an
exact device name, then prints the confirmed selection. Duplicate display names
are numbered in the list but remain ambiguous to the name-only CLI; select those
inputs in Desktop's picker instead. Quote names containing spaces. `microphone
default` clears a named preference in favor of the operating
system's default and prints the confirmed selection.

`status` never launches Desktop. Its human output contains only gateway state,
window state, and the selected PID; `--json` prints those same redacted fields
for scripts. The command returns an error when Desktop is not running.

The CLI finds `gsv-desktop` beside `gsv`, then on `PATH`. Development builds
also recognize the legacy `gsv-native` binary name. Set `GSV_DESKTOP_PATH` to
an explicit executable when testing a nonstandard installation.

These commands use the versioned same-user IPC contract in
`desktop-protocol`; they do not connect through `gsvd`. Credentials,
messages, drafts, attachment paths, and approval content cannot be sent over
that contract. Microphone names cross it only for the explicit microphone
commands and are never included in the general redacted Desktop status. Desktop
remains the owner of gateway authentication, process selection, microphone
preference, and process-switch fencing.

## Daemon Commands

```bash
gsv daemon install [--id ID] [--workspace PATH]
gsv daemon start
gsv daemon restart
gsv daemon stop
gsv daemon uninstall
gsv daemon status
gsv daemon doctor
gsv daemon reload
gsv daemon reconnect
gsv daemon diagnostics [--json]
gsv daemon logs [-l N] [--follow]
```

The device daemon exposes local hardware-style capabilities to the Kernel:
`fs.*`, `shell.exec`, and `net.fetch`. The gateway always sees the same syscall/tool surface;
the device ID selects which implementation receives a driver request.

The driver runtime is the separate `gsvd` executable. The hidden legacy command
`gsv device run` transfers process ownership to the sibling
`gsvd --foreground`; the CLI never embeds the driver. `install` creates and
starts a launchd agent on
macOS, a systemd user unit on Linux, or a scheduled task on Windows. Reinstalling
or starting an old definition migrates `gsv device run` to the direct `gsvd`
entrypoint without changing the existing service identity. `doctor` checks the
installed executable and definition. The daemon writes daily rotated JSONL logs
under `~/.gsv/logs/device.log*`; `logs` tails the latest file with `-l, --lines`
defaulting to `100`. Foreground logs use compact text by default; set
`GSV_DEVICE_CONSOLE_FORMAT=json` or `GSV_DEVICE_CONSOLE_FORMAT=quiet` to change that.

`reload` rereads `config.toml` and reconnects, while `reconnect` keeps the
current settings. `diagnostics` reports bounded, redacted runtime notices.
`status` combines the operating-system service state with the live daemon's
version, PID, machine id, connection phase, uptime, and reconnect count. These
live operations use a versioned same-user Unix socket on macOS/Linux and a
current-user Windows named pipe. They do not expose credentials or gateway
traffic.

Device identity resolves as `--id`, then local `device.id`, then
`device-<hostname>`. Workspace resolves as `--workspace`, then
`device.workspace`, then the current directory. A persistent daemon should have
`gateway.username` and `device.token` configured, usually from
`gsv auth setup --device-id ...` or
`gsv auth token create --kind device --device ...` followed by
`gsv config --local set device.token ...`.
Because the compatibility launcher replaces itself with `gsvd`, gateway setup
must be completed before starting `gsvd`; use `gsv auth setup` when connecting
to a new deployment.

`gsv`, `gsvd`, and the Desktop application share protocol and configuration
crates but remain separate applications. The CLI owns operator commands and OS
service control; `gsvd` owns machine syscalls, subprocesses, transfers,
cancellation, reconnection, logging, and shutdown.

The verified host installer ships `gsv` and `gsvd` as a matching pair and
migrates an existing legacy service definition during upgrade. See
[Install Host Applications](/how-to/install-host-apps) for the release matrix,
checksum verification, and rollback contract.

## Auth Commands

```bash
gsv auth setup [--username USER] [--new-password PASS] [--root-password PASS] \
  [--ai-provider ID] [--ai-model MODEL] [--ai-api-key KEY] \
  [--device-id ID] [--device-label LABEL] [--device-expires-at UNIX_MS]
gsv auth login [--username USER] [--password PASS] [--ttl-hours N]
gsv auth logout
gsv auth link [CODE]
gsv auth link --adapter ID --account-id ACCOUNT --actor-id ACTOR [--uid UID]
gsv auth link-list [--uid UID]
gsv auth unlink --adapter ID --account-id ACCOUNT --actor-id ACTOR
```

`setup` initializes a gateway in setup mode, optionally configures AI provider
settings, and can issue a device token with `--device-id`, `--device-label`, and
`--device-expires-at` (Unix milliseconds). Interactive setup prompts for missing
values and saves `gateway.username`, `device.id`, and `device.token` when issued.

`login` creates a short-lived user token with `sys.token.create` and caches it
locally. The default TTL is 8 hours. `logout` clears only the cached local session
token.

Link commands bind adapter identities, such as WhatsApp or Discord actors, to
GSV users. Use a one-time `CODE` from an adapter flow or provide the adapter,
account, and actor identifiers manually.

WhatsApp setup has two separate links: QR pairing authenticates the adapter as
a linked device, then a direct message identifies its sender. After the adapter
reports authenticated, send a new direct message from the personal WhatsApp
account to the number paired with GSV. Enter the one-time reply while logged in
as the intended GSV user:

```bash
gsv auth link CODE
```

The code expires after ten minutes. The message that generated it is not sent
to an agent, so send another message after the command succeeds.

### Auth Tokens

```bash
gsv auth token create [--kind device|service|user] [--uid UID] [--label LABEL] \
  [--role driver|service|user] [--device DEVICE] [--expires-at UNIX_MS]
gsv auth token list [--uid UID]
gsv auth token revoke TOKEN_ID [--reason TEXT] [--uid UID]
```

`device` is the default token kind. Use `--device` to bind a driver token to one
device ID. `--uid` is for root-managed token operations.

## Config Commands

```bash
gsv config get [KEY]
gsv config set KEY VALUE
gsv config --local get KEY
gsv config --local set KEY VALUE
```

Without `--local`, commands use Kernel `sys.config.get` and `sys.config.set`.
Keys use ConfigStore paths, for example:

```bash
gsv config get config/ai/provider
gsv config set users/1000/ai/model gpt-4.1-mini
```

Omit `KEY` on remote `get` to list visible entries. Sensitive remote values are
masked for non-root users. Non-root writes are limited to their own user
overrides, currently `users/{uid}/ai/*`.

With `--local`, commands edit `~/.config/gsv/config.toml`. Supported local keys:
`gateway.url`, `gateway.username`, `gateway.token`, `gateway.session_token`,
`gateway.session_token_id`, `gateway.session_expires_at`,
`gateway.session_expires_at_ms`, `release.channel`,
`session.default_key`, `device.id`, `device.token`, and `device.workspace`.
`release.channel` must be `stable` or `dev`; token values are masked
on local `get`. Adapter workers use Cloudflare service bindings rather than
locally configured WhatsApp URLs or tokens.

## Adapter Commands

```bash
gsv adapter connect --adapter ID [--account-id ACCOUNT] [--config-json JSON]
gsv adapter disconnect --adapter ID [--account-id ACCOUNT]
gsv adapter status --adapter ID [--account-id ACCOUNT]
```

Adapters are long-lived external account bridges. `--account-id` defaults to
`default` for connect/disconnect. A normal WhatsApp connect displays a private
Linked Devices QR challenge in a supported terminal:

```bash
gsv adapter connect --adapter whatsapp --account-id personal
gsv adapter status --adapter whatsapp --account-id personal
```

Treat that QR like a password. If terminal rendering fails, the CLI hides the
underlying payload. `--config-json` must be a JSON object and is passed to the
adapter implementation. WhatsApp accepts `{"force":true}` only as destructive
recovery: it clears the existing linked-device authentication and starts a new
QR pairing. Routine transport recovery does not use it.

Cloudflare lets an active outbound connection prevent Durable Object eviction
for at most 15 minutes. The account schedules an alarm every 30 seconds so an
incoming event reaches the Durable Object before Cloudflare's minimum idle
eviction window. Routine residency maintenance therefore keeps the same
WhatsApp provider session; only an unhealthy transport reconnects.

If the account is paired but a direct message gets no link-code reply, first
confirm `gsv adapter status` reports connected and authenticated. Send a fresh
DM from the sender account to the paired GSV number, not from the paired account
itself or from a group. If it still gets no reply, verify that the Gateway and
`channel-whatsapp` workers are deployed with both service bindings and inspect
both workers' live logs. For an expired or already-used code, send a new DM and
run `gsv auth link` with the new code.

## Version

```bash
gsv version
gsv --version
```

Prints build metadata for the installed CLI.

## Renamed or Removed Commands

| Old command | Current command |
| --- | --- |
| `gsv client` | `gsv chat` |
| `gsv session` | `gsv proc` |
| `gsv local-config` | `gsv config --local` |
| `gsv deploy`, `gsv infra` | Removed; use the public Alchemy stack or Managed GSV. |
| `gsv tools`, `gsv skills`, `gsv init` | Removed from the current CLI. |

## See also

- [Get Started](../get-started/)
- [Connect Devices](../how-to/connect-devices)
- [Guides](../how-to/)
- [Routing Reference](./routing.md)
