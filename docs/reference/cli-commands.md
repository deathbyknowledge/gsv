# CLI Command Reference

`gsv` is Ship from your terminal. It talks to your Ship, looks after the work
and routines it runs, reaches files and commands on connected places, and
manages this computer's connection. Remote commands use the Kernel syscall
surface over WebSocket; `desktop` and `daemon` use same-user local endpoints.

```text
Talk
  ship [MESSAGE]     Talk to your Ship, or open a prompt (also: chat)
  contacts           People you talk to, and invitations
  requests           Message requests from people you don't know yet
  mail               Your Ship's mailbox

Look after things
  work               What your Ship and its helpers are doing
  routines           Things your Ship does on a schedule
  memory             Your wiki, and the notes your Ship always reads
  activity           What ran, where, and how it went

Places
  files              Files on your Ship or a connected place
  run                Run one command on your Ship or a connected place
  places             Computers and browsers connected to your Ship

This computer
  login [SPACE]      Sign in to your Ship
  logout             Sign out
  status             Check sign-in, pairing and the background service
  pair CODE          Connect this computer to your Ship
  unpair             Disconnect this computer
  update             Check for a newer Ship for this computer
  desktop            Open Ship Desktop
  version            Show version and build details
```

`gsv` alone prints this list; `gsv help COMMAND` explains one command.

## Output

Every command prints a rendering for people: a heading, aligned columns,
relative times such as `2 h ago`, human sizes, and rows shortened to the
terminal width. Long names and subjects are cut with `…` so each row fits.
Piped output is laid out for 100 columns. Colour appears only on a terminal,
and never when `NO_COLOR` is set or `TERM=dumb`. `COLUMNS` overrides the
detected width. An empty list says what to do next.

Lists show short ids, the first eight characters of the full id. Any unique
prefix works wherever a command takes an id, so `gsv work show 8f3a` is enough.
An ambiguous prefix is refused with the matching candidates.

`--json` works on every command and prints the full structured result, with
full ids, for scripts:

```bash
gsv mail --json | jq '.messages[].subject'
```

Errors are one plain sentence on stderr. A refused syscall keeps its call
name and code in a dim suffix so it stays diagnosable. An expired or missing
sign-in says to run `gsv login`.

## Sign In

```bash
gsv login [SPACE] [--username USER] [--password PASS] [--ttl-hours N]
gsv logout
gsv status
```

`login` takes your Ship's address, such as `gsv login me.ship.space`, and
remembers it; later logins can omit it. A bare host becomes `wss://HOST/ws`
(`ws://` for `localhost`), and an `http(s)://` address is converted. The
address is saved only after a successful sign-in. `login` asks only for the
password of your personal account; pass `--username root` for administration.
It creates a short-lived user session with `sys.token.create` (8 hours by
default) and saves it in `~/.config/gsv/config.toml`. Signing in to a
different Ship forgets the previous account name.

`logout` revokes the session on the Ship with `sys.token.revoke`, then clears
it locally. When the Ship can't be reached, the local session is still cleared
and the command says so.

`status` never prompts. It shows the Ship, whether you are signed in and until
when, whether this computer is paired, its background service, and the CLI and
Ship versions, followed by the next step when something is missing.

Scripts and service units can skip the saved sign-in with options placed
before the command. They are hidden from help:

| Option | Env | Description |
| --- | --- | --- |
| `--url <URL>` | `GSV_URL` | Ship WebSocket URL. Defaults to the address saved by `gsv login`, then `ws://localhost:8787/ws`. |
| `-u, --user <USER>` | | Account name override. |
| `-t, --token <TOKEN>` | `GSV_TOKEN` | Non-interactive credential. User commands default to the personal account; device credentials keep their enrolled username. |

To get a credential for CI, use the hidden token commands, kept for one
release:

```bash
gsv auth token create [--kind machine|service|human] [--label LABEL] [--peer PEER_ID] [--expires-at UNIX_MS] [--uid UID]
gsv auth token list [--uid UID]
gsv auth token revoke TOKEN_ID [--reason TEXT] [--uid UID]
```

`create` prints the token once; store it straight away. `machine` is the
default kind and needs `--peer`, the one peer id that may connect with it.
`--uid` is for root-managed tokens. Computers normally get their credentials
from a pairing invitation instead.

## Talk

### Ship

```bash
gsv ship [MESSAGE]
gsv ship history [-n N]
gsv ship search WORDS
```

`chat` is an alias of `ship`. With a message (quotes are optional), `ship`
sends it to your Ship conversation with `conversation.send`, prints the reply
as it streams, and returns when the run finishes, for up to 600 seconds. When
the run fails, `ship` prints one plain line with the diagnostic reference,
such as `Your Ship couldn't answer. (ref 7afee6a6)`, and exits 1; `--json`
includes the full error.

Each tool the Ship uses leaves one line, such as `· Checking your calendar`:
the purpose the Ship gave, or else the activity wording, such as
`ran a command`, or else the tool's name. While the Ship thinks or a tool
runs, a spinner on stderr says what is happening; it appears only when
stderr is a terminal and never with `--json`, and it is erased before
anything else prints.

On a terminal, replies are rendered line by line as they arrive: headings in
bold, `•` bullets, quotes behind `│`, code blocks indented without their
fences, inline bold, italic and code, and links as `text (url)`, or as
clickable links in terminals known to support them. Tables are left as
written. Piped replies stay raw Markdown.

Piped input counts as the message:

```bash
git diff | gsv ship "review this"
```

Without a message it opens a prompt (`›`). Each line is sent as soon as you
press Enter, so a new message can supersede an active run; `/quit` leaves.
Tool use and notices appear dimmed on stderr. When the Ship asks to do
something that needs your approval, the prompt shows what and why, never cut
to the terminal's width, and takes `o` (once), `a` (always), `b` (block) or `v`,
which prints every argument of the action before you decide. Without a terminal the request waits
for an answer in the web app or on a messenger. `--json` needs a message and prints
`{ conversationId, sent, replies }`. Set `GSV_CLIENT_DEBUG=1` to trace
run-signal matching.

`history` prints recent messages and `search` finds past ones with
`conversation.search`.

### Contacts and requests

```bash
gsv contacts
gsv contacts inbox
gsv contacts invite [--days N]
gsv contacts accept LINK_OR_CODE
gsv contacts send NAME MESSAGE
gsv contacts block NAME
gsv contacts unblock NAME
gsv requests
gsv requests accept ID
gsv requests decline ID
```

`contacts` lists people on other Ships by name and address. `NAME` matches a
contact's local alias, display name or handle. `invite` creates a one-use
invitation and prints its link and code, which you share yourself; `--days`
sets how long it lasts (one hour by default, up to seven days). `accept` uses
an invitation someone shared with you. `inbox` lists contact conversations
with the newest first.

`requests` lists first-message requests from people who found your public
profile, and the ones you sent. `accept` and `decline` answer an incoming
request; `decline` on your own request withdraws it.

### Mail

```bash
gsv mail [--page N] [-n N]
gsv mail search WORDS [--page N] [-n N]
gsv mail read ID
gsv mail send TO [-s SUBJECT] [MESSAGE]
gsv mail status DELIVERY_ID
```

`mail` lists received mail with the newest first, 20 at a time, using
`mail.list`. A message that needs attention is marked, and attachments are
counted beside the subject. When more mail exists, the footer prints the
command for the next page, such as `gsv mail --page 2`. Pages are counted
from the newest message, so `--page 3` walks past the first two pages with
the `mail.list` cursor and keeps no state; new mail can shift a page. Scripts
can follow the `next` cursor of a `--json` result with the hidden
`--before CURSOR` option instead. `search` uses `mail.search` with the same
paging. `read` prints the message's header, then its body.

`send` sends from your Ship's address. The body comes from `MESSAGE` or, when
it is omitted, from stdin. It prints a delivery id for `status`. Sending
follows the ordinary `mail.send` approval policy.

## Look After Things

### Work

```bash
gsv work [--all]
gsv work show ID [-n N]
gsv work open ID [MESSAGE]
gsv work stop ID
gsv work reset ID [-y]
gsv work end ID [-y]
```

`work` lists what is running now: your Ship and the work it delegated, with
state, last activity and how many messages are queued. Idle work is counted
in a footer; `--all` lists it. Open commitments from the Ship's responsibility
ledger follow, with their state, due time and blocker.

`show` prints a timeline of what a piece of work did, folding each tool result
into its call. `open` talks to that work as `ship` does, with a message or as a
prompt. `stop` ends its current run with `proc.abort`; the work itself remains.
When an action is waiting for approval, `show` displays it; answer it in the web
app or on a messenger.

`reset` archives a piece of work's history and starts it fresh with
`proc.reset`; on your Ship it starts the conversation context over. `end`
archives the history and tears the work down for good with `proc.kill`; your
Ship itself can't be ended. Both ask first and report how many messages were
archived. Without a terminal they refuse unless `--yes` is given.

### Routines

```bash
gsv routines
gsv routines add NAME MESSAGE (--daily HH:MM | --weekly "DAY HH:MM" | --every INTERVAL | --cron EXPR | --at WHEN) [--timezone ZONE]
gsv routines edit ID [--name NAME] [--message MESSAGE] [CADENCE] [--timezone ZONE] [--pause | --resume]
gsv routines remove ID
gsv routines run ID
```

A routine asks your Ship to do something on a schedule. Each run becomes one
Ship responsibility, exactly as routines made in the web app do. Daily, weekly
and cron times use your Ship's time zone (your account's, then the Ship's,
then UTC) unless `--timezone` names another. `--every` takes `30m`, `2h` or
`1d`. `--at` runs once, at `tomorrow 09:00`, `today 18:30` or
`2026-10-29 18:00`, read in the same time zone; a time that has passed is
refused. `routines` lists each routine's cadence, such as
`once · Thu 29 Oct 18:00`, its next run and last result.

```bash
gsv routines add "Morning briefing" "Plan my day" --daily 08:00
gsv routines add "Pick up the parcel" "Remind me" --at "tomorrow 18:00"
gsv routines edit 4410 --pause
```

### Memory

```bash
gsv memory
gsv memory read WIKI/PAGE
gsv memory search WORDS [--in WIKI]
gsv memory standing
```

`memory` lists your wikis. `read` prints a page, such as
`gsv memory read notes/index.md`, and `search` searches every wiki or one.
`standing` shows the notes your Ship reads in every conversation, from your
`~/context.d`.

### Activity

```bash
gsv activity [--on PLACE] [-n N]
```

`activity` lists recent syscalls from the ledger: what ran, where, how long it
took and whether it worked. Calls read in the web app's words, such as
`ran a command`; a call without a label shows its name. Arguments stay out of
the table.

## Places

A place is your Ship itself (`gsv` or `ship`) or a connected computer,
browser or cloud instance. Commands name a place by its label or id, in any
case.

### Connected places

```bash
gsv places
gsv places rename PLACE NAME
gsv places forget PLACE [-y]
```

`places` lists connected places, online first. `rename` changes a place's
label. `forget` asks first, then removes a computer and revokes its
credentials with `sys.target.delete`; for a cloud browser or computer it
stops the instance instead.

### Files

```bash
gsv files
gsv files ls [PATH]
gsv files cat PATH
gsv files put LOCAL PATH
gsv files get PATH [LOCAL]
gsv files cp FROM TO
gsv files rm PATH
gsv files search QUERY [PATH] [--include GLOB]
```

`gsv files` alone lists your Ship's home folder, as `gsv files ls` does.
A path is on your Ship unless it starts with a place name and a colon, such as
`laptop:~/notes.txt` or `laptop.local:~/notes.txt`. Single letters (`C:\`) and
paths starting with `.`, `/` or `~` are never read as place names, and a dotted
name that matches no place stays a path on your Ship. `cat` prints text up to 16 MiB. `put`
and `get` stream through this computer; `get` writes a partial file and
renames it only when the download completes. `cp` copies between places on the
Ship side without passing through this computer.

### Run

```bash
gsv run [--on PLACE] [--cwd DIR] COMMAND...
```

`run` runs one command line with `shell.exec` on your Ship or `--on` a place,
prints its output, and exits with the command's own status. Ctrl-C stops it
with `shell.cancel` and exits 130. Options for `gsv` itself, such as `--json`,
go before the command. `run` doesn't pass stdin through. On your Ship the
command runs in the Ship's shell, whose commands are listed under
[Commands on your Ship](#commands-on-your-ship).

```bash
gsv run --on laptop df -h
gsv run r12y list
```

## This Computer

Open **Work**, click **connect** beside Connections, name the computer and
create an invitation. After installing Ship, paste the provided command:

```bash
gsv pair CODE [--workspace PATH] [--no-install]
gsv pair  # resume an interrupted exchange
gsv unpair [-y]
gsv update
```

Use `gsv pair -` to read the invitation from stdin instead of exposing it in
process arguments. `--preserve-cli-login` leaves the CLI's selected Ship and
credentials unchanged; `--no-replace` refuses to overwrite an existing machine
credential. Desktop uses these together for integrated machine setup.

The invitation supplies the gateway, account and target identity. It expires in
ten minutes and can enroll one device. The CLI saves its credential before the
exchange and installs the per-user daemon by default. `--no-install` saves the
pairing without changing operating-system services. Closing the web panel or
cancelling an already-used invitation does not revoke the resulting connection.

`unpair` asks first, then forgets this computer on the Ship, which revokes its
credential, removes the background service and clears the saved machine
credential. Your CLI sign-in stays.

`update` compares this computer with your Ship's release. When a newer one is
available it prints the installer command that updates the CLI, background
service and Desktop together; it doesn't run it.

### Background service

Ship can create an invitation from Shell on `gsv` with
`targets pair --name "My laptop" --platform mac`. Supported platforms are `mac`,
`linux`, `windows` and `browser`. The result contains setup instructions for the
Ship's release. `targets pair list` and `targets pair cancel INVITATION_ID`
manage the human owner's invitations. See [Connect devices](../how-to/connect-devices.md).

For `--platform browser`, the JSON result includes `extensionUrl` and `code`.
The URL opens `https://ship.space/browser?release=RELEASE` for the gateway's
release. Download and unzip the extension, load its folder from
`chrome://extensions` with developer mode enabled, then open **Your Ship** from
the toolbar or Extensions button and paste `code` into its panel.


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
macOS, a systemd user unit on Linux, or an automatic SCM service on Windows. Windows installation requests administrator
approval and uses a dedicated service account. On Unix, reinstalling
or starting an old definition migrates `gsv device run` to the direct `gsvd`
entrypoint without changing the existing service identity. `doctor` checks the
installed executable and definition. The daemon writes daily rotated JSONL logs
under `~/.gsv/logs/device.log*` (Windows service logs use
`%ProgramData%\GSV\daemon\logs`); `logs` tails the latest file with `-l, --lines`
defaulting to `100`. Foreground logs use compact text by default; set
`GSV_DEVICE_CONSOLE_FORMAT=json` or `GSV_DEVICE_CONSOLE_FORMAT=quiet` to change that.

`reload` rereads `config.toml` and reconnects, while `reconnect` keeps the
current settings. `diagnostics` reports bounded, redacted runtime notices,
including the daemon's latest automatic-update decision; the installer it
starts logs to `~/.gsv/logs/auto-update.log`, and `device.auto_update`
turns automatic updates off. Windows boot services always use administrator-managed
installer updates. On Windows, `reload` copies the enrolled owner's device settings
to the protected service configuration; changing its workspace requires `install`
to update filesystem permissions. `reconnect` only reconnects.
`status` combines the operating-system service state with the live daemon's
version, PID, machine id, connection phase, uptime, and reconnect count. These
live operations use a versioned same-user Unix socket on macOS/Linux and a
Windows named pipe restricted to the enrolled service owner and execution account. They do not expose credentials or gateway
traffic.

Device identity resolves as `--id`, then local `device.id`, then
`device-<hostname>`. Workspace resolves as `--workspace`, then
`device.workspace`, then the current directory for a foreground daemon.
Windows pairing and service installation default to `%USERPROFILE%\GSV`.
The enrolling user must already be able to change the workspace's permissions.
Workspace grants and removal run at that user's original privilege level;
administrator approval only authorizes the protected service registration.
A persistent daemon needs `gateway.username` and `device.token`, which the
device invitation flow saves.
Because the compatibility launcher replaces itself with `gsvd`, gateway setup
must be completed through the Ship's browser setup invitation before starting
`gsvd`. See the [device guide](../how-to/connect-devices.md) for enrollment.

`gsv`, `gsvd`, and the Desktop application share protocol and configuration
crates but remain separate applications. The CLI owns operator commands and OS
service control; `gsvd` owns machine syscalls, subprocesses, transfers,
cancellation, reconnection, logging, and shutdown.

The verified host installer ships `gsv` and `gsvd` as a matching pair and
migrates an existing legacy service definition during upgrade. See
[Install Host Applications](/how-to/install-host-apps) for the release matrix,
checksum verification, and rollback contract.

Windows service installation requires the bundled `gsvd.exe` beside `gsv.exe`;
`GSV_GSVD_PATH` and `PATH` do not override that selection. The CLI checks the
daemon before administrator approval and verifies the same bytes before copying
them to the protected service directory. Reinstall the complete distribution if
the bundled daemon is missing or has changed during approval.


### Desktop

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
use the `gsv-desktop` binary. Set `GSV_DESKTOP_PATH` to
an explicit executable when testing a nonstandard installation.

These commands use the versioned same-user IPC contract in
`desktop-protocol`; they do not connect through `gsvd`. Credentials,
messages, drafts, attachment paths, and approval content cannot be sent over
that contract. Microphone names cross it only for the explicit microphone
commands and are never included in the general redacted Desktop status. Desktop
remains the owner of gateway authentication, process selection, microphone
preference, and process-switch fencing.


### Local configuration

```bash
gsv config --local get KEY
gsv config --local set KEY VALUE
```

These hidden commands edit `~/.config/gsv/config.toml`. Supported keys:
`gateway.url`, `gateway.username`, `gateway.token`, `gateway.session_token`,
`gateway.session_token_id`, `gateway.session_expires_at`,
`gateway.session_expires_at_ms`, `release.channel`,
`session.default_key`, `device.id`, `device.token`, `device.workspace`, and
`device.auto_update`.
`release.channel` must be `stable` or `dev`; `device.auto_update` must be
`true` or `false`; token values are masked on `get`. Ship settings live in the
web app.

## Removed Commands

These commands were replaced. For one release they still parse and exit with a
pointer to their replacement.

| Was | Now |
| --- | --- |
| `gsv chat [--pid PID]` | `gsv ship`; `gsv chat` remains an alias. `--pid` became `gsv work open ID`. |
| `gsv shell` | `gsv run COMMAND`, one command at a time. |
| `gsv proc list` / `send` / `history` | `gsv work`, `gsv work open ID MESSAGE`, `gsv work show ID`. |
| `gsv proc reset` / `kill` | `gsv work reset ID` / `gsv work end ID`. |
| `gsv auth login` / `logout` | `gsv login SPACE` / `gsv logout`. |
| `gsv auth token ...` | Still works, hidden, for one release; see [Sign In](#sign-in). |
| `gsv auth link` / `link-list` / `unlink` | Pair messengers in **Settings → Messengers**. |
| `gsv config get` / `set` (remote) | Change Ship settings in the web app. |
| `gsv adapter ...` | Connect messengers in **Settings → Messengers**. |

The global `-p, --password` option is gone; scripts use `gsv login --password`
or a `-t` / `GSV_TOKEN` credential.

## Commands on Your Ship

Your Ship's own shell, the `gsv` target, has commands of its own. Ship uses
them through its Shell tool, and you can run them with `gsv run`, for example
`gsv run r12y list` or `gsv run sched list`. The examples below are written as
they are typed inside that shell.

When the operator enables feedback, the web app's header has a **feedback** action.
Reports include the text you submit, your Ship, account, and app/server versions.
The optional **Include last 20 Ship messages** checkbox starts unchecked. It
captures recent messages, thinking, tool inputs/results and runtime events through
your existing history permissions. Review the snapshot before sending: tool results
can contain private content. No files or media are fetched for the report, and
oversized activity is visibly shortened to 64,000 characters. Unchecking removes it. A failed submission keeps your draft
and the exact selected snapshot for retry.
The same report can be sent from the Ship's shell:

```bash
feedback < report.txt
```

Use a report file rather than inline text, `printf`, or a heredoc: shell command
text is recorded in Logs.

Ship can use this command when asked to report an issue. Send only the details the
user wants shared. `feedback --id UUID < report.txt` keeps the same report identity on a retry.
Reports go to the operator's configured inbox; the public runtime has no default
destination. The header action appears only when `sys.connect` advertises
`operator-feedback` for the caller.


The Ship's shell exposes messenger pairing to Ship and signed-in users:

```bash
messenger list
messenger setup whatsapp
messenger inspect whatsapp < code.txt
messenger connect whatsapp < code.txt
```

`setup` returns adapter-owned instructions for getting a code. The user can
paste it into their conversation and let Ship connect it for them. Save the
code to a file with Write, read it through stdin, then remove the file; avoid
putting it in logged shell command text. `connect` returns `paired: true` only
after redemption completes. Processes link their human owner's account, subject
to their capabilities and tool policy. See [Connect a messenger](/how-to/messengers).

With the optional cloud instance service enabled, the Ship's shell also exposes
`instance catalog`, `instance start browser --request-id ID --wait`, `instance list`,
`instance get ID`, and `instance stop ID --wait`. Starting reuses the account's current
browser and reports `created` or `reused`; `--new` explicitly creates a separate
temporary one. `--wait` waits for readiness for up to 60 seconds by default
(`--timeout MS`, maximum 120000). Cancelling the wait leaves the instance running.
Get and stop accept the displayed target ID or full instance ID. Ordinary browsers
save before stopping. Partial saves report `persistence.issues` for affected
sites and permit normal stop; other sites are saved. A whole-save failure leaves
the browser running and reports its cause and diagnostic. Stop `--wait`
waits for termination and release of saved state. Retry a save with
`browser profile save ID`, or explicitly discard unsaved changes with
`instance stop ID --force --wait`. Force is not a persistence test and cannot fix
unsupported website storage. Inspect save status and per-site usage with
`browser profile get PROFILE_ID`; `browser profile delete PROFILE_ID` forgets
saved logins and stops the browser using them.
Ordinary browsers
remember logins automatically. Use `browser handoff` when Ship needs a human to
complete a sign-in; opening Work's browser view otherwise leaves Ship running
and accepts direct input. These are native target commands, available to Ship
through Shell as well. See [cloud browsers](/how-to/cloud-browsers) for saved
logins, recovery after a lost response, and the complete sign-in flow.

When computers are enabled, `instance start computer --request-id ID --wait`
creates a temporary Linux target. `--name NAME` and `--seconds N` choose its label
and lifetime. A new request ID creates a new computer; retrying the same request
recovers that operation. Computers do not accept browser profile or `--new`
options. Use the same list, get and stop commands; stopping destroys the files
and running commands. See [cloud computers](/how-to/cloud-computers).

Inside the Ship's shell, `proc` is the process IPC userland command.
`message` inspects and uses external chat reply routes. `sched add --ship`
creates recurring or one-shot Ship responsibilities; `sched add --here`
targets the resolved current Process and uses the same responsibility semantics
when that Process is Ship.
`crontab` schedules background shell commands, while the remaining `sched`
commands inspect and control the Kernel schedule records:

```bash
proc self
proc list
proc spawn [--as ACCOUNT] [--non-interactive] [--label LABEL] [--model MODEL_ID] [--effort LEVEL] [--prompt TEXT] [--] [prompt]
proc delegate [--as ACCOUNT] [--label LABEL] [--model MODEL_ID] [--effort LEVEL] [--check-after 10m] [--responsibility ID] <task>
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
message search QUERY [--with CONTACT_OR_CONVERSATION] [--before SEQUENCE] [--limit N] [--json]
message delivery show DELIVERY_ID [--json]
message send [--message TEXT]
yield
message send --to DESTINATION [--message TEXT] [--attach PATH]... [--mime TYPE] [--delivery-id ID] [--responsibility ID] [--also]
contact find @HANDLE|ADDRESS
contact list [--all] [--json]
contact alias CONTACT_ID NAME|--clear
contact invite create --handling manual|ship [--expires DURATION]
contact invite accept LINK_OR_CODE --handling manual|ship
contact invite list [--all] [--json]
contact invite cancel INVITE_ID
contact handling CONTACT_ID manual|ship --revision N
contact revoke CONTACT_ID
contact request list [--contact CONTACT_ID] [--all] [--json]
contact request create --contact CONTACT_ID --kind KIND --title TITLE [--details JSON] [--delivery-id ID]
contact request update REQUEST_ID --state STATE [--revision N] [--details JSON] [--delivery-id ID]
atproto identity
atproto create COLLECTION [--rkey RKEY] (--json RECORD | --file PATH)
atproto put COLLECTION RKEY (--json RECORD | --file PATH)
atproto delete COLLECTION RKEY
atproto apply (--json WRITES | --file PATH)
atproto blob PATH [--mime TYPE]
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
durable child whose ordinary final assistant output returns to its caller as a process event; it
requires a process-backed caller and must not be placed in a crontab. Passing
`--responsibility ID` assigns that existing Kernel record to the child before
IPC admission and restores its prior Ship state if admission fails. Completion,
failure, or explicit termination returns a still-active assignment to Ship exactly
once; the IPC event carries the child result and the responsibility retains stable
call and run references. `--check-after` sets a 10-minute supervision cadence by
default. Each check-in reports that work is still running and renews the result
route without cancelling the child. The legacy `--timeout` spelling is accepted as
an alias for `--check-after`; it is not a delegation deadline.

Both commands accept `--model MODEL_ID` and `--effort LEVEL` (`--reasoning` is an
alias). These are process-local preferences stored before the first task starts.
The model ID names an entry in the owning human's stack and puts it first without
disabling fallbacks. Effort is `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
Omitted preferences inherit agent/account defaults; a child's process-local
preferences are independent of its parent's. JSON spawn accepts the equivalent
`"ai": { "modelId": "quick", "reasoning": "high" }` object.

`proc send` is asynchronous same-owner process mail. `proc call` is bounded:
the source process receives either
`ipc.reply` or `ipc.timeout` as a delegated task event. In a process-backed
shell, `proc self` prints the current process id and the shell exports it as
`GSV_PID`; a top-level user shell has no current process, so `proc self` exits
with an error there. `proc list` labels the one canonical process as
`kind=personal`; all other entries are `kind=work`, even when they run as the
same personal-agent account.

Inside an active process, `proc compact --summary '...'` saves a handover for
installation after the current tool batch finishes. The original request and
unseen tool results stay intact, alongside enough recent original exchanges to
fill the configured low-water budget (40% by default, including instructions,
tools and handover). History that already fits stays unchanged.
No history ids or new process are needed.
For an idle process, use `proc compact --pid PID` with one of `--keep-last N`,
`--through-message-id ID` or `--target-pressure N`, and either `--summary TEXT`
or `--generate-summary`. See [Context Compaction](../architecture/context-compaction.md).

`proc history --archive PATH --generation N --after-message-id N
--through-message-id N --offset N --limit 10 --full` pages an immutable gzip
archive through normal filesystem permissions, including after the source
process is killed. Message filters use the original IDs. Continue with the
reported `next_offset` until `has_more=false`; `--json` returns the raw archived
message page. The reader streams decompression instead of buffering the entire
archive in a shell pipeline.

`r12y` manages the Kernel's durable unresolved-work ledger. `list` omits
terminal records unless `--all` is supplied. Waiting work must name a future
check time or a blocker. Prefer `proc delegate --responsibility ID ...` for a
new durable worker; the lower-level `r12y delegate ID PID --until ISO` command
assigns an already-existing owned process with an explicit recovery deadline.
`r12y sources` lists required runtime contracts as `always-on` and configurable
producers as `configurable`. Only configurable producers can be changed. Use
`r12y source disable mail.received` to keep accepting mail without creating a
Ship responsibility for each message; enabling it affects future completions.
`mail address` prints this GSV's own address, the space handle at the
installation's managed-mail domain (for example `<handle>@gsv.space` on the
public service), which the runtime facts also list; `man --search` ranks `mail`
for sign-up, verification code, receipt and tracking questions, and reports it
unavailable when the installation has no mailbox.
Other configurable sources cover federation ingress, new contacts, new machines,
connected adapters, and adapter authentication loss.

`skills list` shows the built-in skills, served read-only from `/sys/skills.d`,
before the owner's and the agent's own. `skills create` writes to the current
account's `~/skills.d` and refuses a built-in name. `man --search` ranks a
command or workflow by what it says about itself; words that appear only in a
skill's body add little, so a long skill does not outrank a matching command.

`message search "words"` searches retained conversation messages saved after search was
enabled, including those later archived, and defaults to Ship. Older search entries
are removed as the conversation database approaches its storage budget; their original
messages remain readable through history. Pre-feature messages are not indexed retroactively.
Search returns newest matches first, with literal word prefixes combined with AND.
`--before` accepts the returned `nextBeforeSequence` to page older matches.
A signed-in user or their Ship may search;
delegated work does not inherit conversation access. Use `message history` with
the match's sequence plus one as `--before` and `--limit 1` to read it in full.

`message current` reports the current run's directed endpoint and exact reply
commands. For an adapter run, text and JSON also include an opaque destination
id suitable for a later or additional `message send --to`; raw provider ids
stay hidden. `message attach` adds one or more Ship filesystem files to the run's
next current-conversation message; it does not create an extra message. The
Process retains each exact source revision in its immutable media archive before
committing the message. `--mime` can classify a single attachment for
presentation while its reference retains the source's authoritative stored
content type. Staged files never go to another destination: a `message send
--to` without its own `--attach` is refused while files are staged, because the
run's next reply would otherwise carry them to the owner. A `message attach`
running in parallel with such a send is refused instead. A direct Shell call using a literal block sends a message and
leaves the run active:

```bash
message send <<'GSV_MESSAGE'
your user-visible response
GSV_MESSAGE
```

Run `yield` when the work is complete. A final message can commit and yield without another model
turn by placing `&& yield` after the block declaration. The Process recognizes these message and
run-control commands without shell approval; the model usually reaches the same three actions
through its `Send` tool, whose `text` and `yield` map onto them exactly. During an active run,
`message send --to ... --also` creates an
additional outbound message or sends to another authorized destination.
`message destinations` lists observed destinations that are online; `--all`
also includes known authorized destinations whose adapter account is offline.
Group, channel, and thread entries appear only after the linked actor addresses
Ship on that exact surface. Entries use opaque Ship ids and generic labels;
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

`txt2img` infers `png`, `jpeg`, or `webp` output format from a known output
extension when `--format` is omitted. `tts` similarly infers its encoding and,
where needed, container from `.mp3`, `.wav`, `.ogg`, `.opus`, `.flac`, or
`.aac`. Both commands verify the returned MIME type before writing. A provider
that cannot honor the requested representation fails without writing
mislabeled bytes; `--json` reports the authoritative MIME type and size on
success.

`img2txt` uses Moondream 3.1 as its only image reader. With no subcommand it
returns a normal caption. `query` requires the caller's prompt; there is no
system query prompt. `ocr` has an extraction-specific default and accepts an
optional caller prompt. `point` returns normalized `{x, y}` coordinates and
`detect` returns normalized bounding boxes. Those two modes print JSON by
default.

`IMAGE` accepts the same target-qualified source forms as `cp`: a local path,
`gsv:/path`, `target:/path`, or `[target-with-colons]:/path`. A target image is
streamed directly through the filesystem transfer boundary into image reading;
the command does not stage a temporary Ship copy. Cloud browser screenshots use
the same source forms and ownership checks as files on connected devices.

Query and OCR structured output accepts `text`, `json`, `xml`, `markdown`, or
`csv`. A JSON `--schema` is added to the caller's instruction, then the result
is parsed and checked before being returned. `--reasoning` exposes query
reasoning and grounding in the `--json` result envelope. `--stream` is
available for caption, query, and OCR, and cannot be combined with `--json`,
reasoning, or structured output. The underlying `ai.image.read` response body
streams decoded UTF-8 chunks; the Ship's shell collects those chunks into its
final `shell.exec` stdout.

The current-conversation form is transport-neutral: issue `message attach`
and `message send` as separate direct Shell tool calls without `--to` or
`--also`. It works whether the run came from a WebSocket client, Desktop, or an
adapter. An explicit destination send during an active run requires `--also`,
acknowledging that it is an additional delivery. Repeat its `--attach` option
to stream multiple Ship filesystem files in one delivery. `--mime` supplies the
delivery type only when exactly one attachment is present. Copy a file from a
connected target to Ship before attaching it:

```bash
cp laptop:/home/alice/report.pdf /tmp/report.pdf
message attach /tmp/report.pdf
message send --message "Here is the report." && yield
message send --to DESTINATION --message "Here is the report elsewhere." --attach /tmp/report.pdf --also
```

If an explicit send is rejected because `--also` is missing, keep `--to` and
add `--also` to the retry. Removing `--to` sends into the process's current
conversation instead; a scheduled Work process does not inherit Ship's
messenger destination.

`message send` allocates a stable delivery id before contacting an adapter and
retries one transport failure with that same id. If delivery still cannot be
confirmed, its error includes the id; pass it back with `--delivery-id` to
reconcile without creating a second logical message. Attachment-open failures
also report that id, including a failure while reopening the file for the
automatic retry. An outcome that may have reached the provider is reported as
`sent=false`, `delivery_confirmed=false`, and `delivery_state=ambiguous`.

`contact` manages relationships with people on other Ships.
`contact find @HANDLE|ADDRESS` reads a published public profile. An unavailable
profile does not establish whether the Ship
exists: the address may be mistyped, the Ship elsewhere, or the profile private.
Private invitations work without a published profile or an existing contact.
`contact connect @HANDLE|ADDRESS --message TEXT --handling manual|ship [--name DISPLAY_NAME]`
sends that profile a first message request, which the person accepts or declines
in People. The request names the version of the profile it read, so their Ship
refuses it if they change their profile or stop taking requests before it arrives.
The signed-in human or their canonical Ship may send it; repeating the same request
returns the existing one.
`contact invite create --handling manual|ship` returns a short-lived one-use code and a shareable `url`;
the other person accepts either while signed in to their own Ship. The default
lifetime is one hour; `--expires` accepts up to seven days. Pairing and revocation may
be performed by the signed-in human or their canonical Ship. `contact list` prints the opaque contact id accepted
by `message send --to`; `message destinations` exposes the same active contacts
alongside messaging endpoints. `contact list --all` adds ended contacts, and one
that ended before DIDs shows `(before DIDs)` as its address. `contact alias` changes only the local display
name; the remote Ship's authenticated identity remains visible and unchanged.

Creating and accepting through Shell require `--handling manual|ship`. Ship asks
for the owner's choice unless it was already given: `manual` leaves new messages
for the person, while `ship` enables automatic handling. Each side chooses
independently. To change an existing contact, read `preferences.revision` from
`contact list --json` and use `contact handling CONTACT_ID manual|ship --revision N`.
The Kernel accepts changes from the owner or their canonical Ship, keeps capability
and revision checks, and starts no work merely because the setting changed.

To invite someone at a known email address, create a private invitation, put its
returned `url` in a message file, and send that file with managed mail:

```bash
contact invite create --handling manual --expires 7d
# Save the returned url and your message in /tmp/invitation.txt before sending.
mail send --to FRIEND_EMAIL --subject 'Connect on Ship' --body /tmp/invitation.txt
mail status DELIVERY_ID
contact invite list --all --json
```

Use `--handling ship` instead when the owner has chosen automatic handling. The
recipient may use a managed Ship mailbox without publishing a profile. Use their
known email address; a custom Ship website address does not establish its mail
domain. Sending follows the ordinary `mail.send` approval policy. Email status
describes transport progress, while invitation status records acceptance. The
recipient still chooses their own handling and accepts the invitation.

`contact invite list --all` exposes retained invitation lifecycle metadata but
never a recoverable code. `message history --with contact:...` reads the Contact
conversation. As opening it in People does, the read then checks whether the
contact's Ship is gone, at most once an hour for each contact. `contact list`
makes no lookup: it ends only contacts whose DIDs the directory cache already
knows were deactivated. A Contact send reports durable local acceptance separately from
remote confirmation; use `message delivery show` with its delivery id.

When Ship contacts someone for an existing task, pass `--responsibility ID` to
associate replies with that open Ship responsibility. A reply continues the same
work without enabling permanent handling of that contact. Acceptance and new
messages stay in People unless the person chooses **Let Ship handle them**.

Use `contact request create` and `contact request update` when the exchange has
a durable lifecycle rather than being only a message. Request revisions prevent
a stale client from overwriting a newer decision. The requester may cancel an
unaccepted offer; only the performer may accept, reject, start, complete or stop
accepted work. `contact request list` includes an `EXCHANGE` column: a locally
recorded update stays pending until the peer confirms it. Failed confirmation
leaves the exchange unsettled, even if the recorded work state is completed.
Resources attached with
`message send --to contact:...` remain immutable references and are streamed by
the receiving Ship only when opened.

`atproto` publishes public records and files on the [open network](/architecture/open-network)
under the Ship's address. It works for the signed-in person and their Ship;
other processes are refused. Nothing publishes while the profile is private,
and the person approves each of the Ship's writes unless a rule allows it. A record's `$type` defaults
to its collection. `apply` commits up to ten writes together from a JSON array
of [`atproto.write`](./syscalls.md#open-network-atproto) changes. To publish a
picture, upload it with `atproto blob PATH`, which prints a `blob` reference,
and put that reference in the record:

```bash
atproto blob trip.jpg
atproto create com.example.note --file note.json
```

`atproto identity` prints the Ship's DID and handle, or `null` until the Ship
first publishes, invites or contacts someone, and what the operator has taken
down, with the reason they gave. `space.ship.profile` belongs to the profile; change it in People.

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
copy its opaque Ship destination id; provider account, actor, and surface ids are
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
0 9 * * * proc spawn --non-interactive --label 'Refresh search index' "Refresh the search index."
```

The crontab file is the desired state: reinstalling it deletes and recreates the
linked Kernel schedule rows, so crontab-backed `sched` ids are not stable. Use
`sched list` to inspect next fire time, last status, error, source, and target.
For a command that invokes `proc spawn`, status `ok` means the command was
dispatched and the spawn was accepted; it does not mean the child finished or
delivered output. `sched list --all` includes disabled schedules; it does not
mean all users. `sched add --json` is a low-level compatibility path for direct
`sched.*` payloads.

## Version

```bash
gsv version
gsv --version
```

Prints build metadata for the installed CLI.

## See also

- [Get Started](../get-started/)
- [Connect Devices](../how-to/connect-devices)
- [Guides](../how-to/)
- [Routing Reference](./routing.md)
