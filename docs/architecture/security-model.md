# Security Model

GSV is powerful personal infrastructure. It can run agent processes, execute
shell commands, read and write files, connect external devices, install
packages, and send messages through adapters. Its security model is therefore
closer to a small Linux-like computer than to a chatbot API.

The core rule is simple: callers authenticate as an identity, receive group
capabilities, and issue syscalls. The Kernel checks those capabilities and then
applies resource-specific rules for files, processes, devices, packages,
adapters, and repositories.

## Trust Boundaries

The Cloudflare account and deployed bindings are the root of trust. Anyone who
can change Worker code, Durable Object state, Worker secrets, R2 buckets, or
bound services can effectively control the GSV instance.

The Kernel Durable Object is the trusted control plane. It owns users, groups,
tokens, capabilities, config, devices, process registry, workspaces, package
records, adapter links, routing tables, and public package state in Kernel
SQLite.

Process Durable Objects run agent loops under a Kernel-issued process identity.
AppRunner Durable Objects run installed package code. CLI devices run on user
machines and execute only the syscalls they advertise, but local OS permissions
remain the final boundary on those machines.

## Authentication

`sys.connect` is the WebSocket login syscall. A client connects as one of three
roles:

- `user`: interactive clients and user tokens; password auth is allowed.
- `driver`: CLI devices; token auth is required and may be bound to one device
  id.
- `service`: adapter/service workers; token auth is required.

Setup mode accepts only setup syscalls until the first user/root credential state
is created. Passwords are stored in `/etc/shadow` form using salted
PBKDF2-SHA-512 hashes. Issued tokens are stored hashed with high-entropy token
prefix metadata, optional expiry, revocation state, allowed role, and optional
device binding. Raw tokens are returned only at creation time.

Password, token, and Git Basic-auth failures use one external
`Authentication failed` result for missing, locked, expired, revoked, or
incorrect credentials. Password verification uses the normal PBKDF2 work even
when the username or password record is absent. Before verification, the
Kernel durably reserves both a source-and-target failure budget and a
source-and-work-class budget in SQLite. The Gateway takes the edge-authored
`CF-Connecting-IP` value and the Kernel immediately converts it to a daily,
HMAC-SHA-256 pseudonym using a random per-ship secret. The secret stays stable;
the UTC-day epoch is included in the signed input and persisted scope so source
pseudonyms rotate without a secret-rotation race. Missing, malformed, or
oversized source headers use one fixed unavailable-source scope. Raw source
addresses, attempted usernames, and credentials are never stored in the
limiter. Target keys contain a SHA-256 hash of normalized username input.
Password and token work have separate per-source ceilings, while one
source-and-target budget spans both credential kinds so changing credential or
client role cannot bypass it.

Login aliases use the account grammar: lower-case ASCII, at most 32
characters. Short casing and surrounding-whitespace variants canonicalize to
the same alias; malformed or oversized representations share one fixed invalid
limiter target and never reach username-derived hashing or database lookup.
Credentials are bounded to 1,024 characters and 2,048 encoded bytes. Larger
values are replaced with a fixed bounded value for dummy verification and
always fail. PBKDF2 records also have bounded iteration, salt, hash, and record
sizes before derivation; corrupt records fail closed through dummy work.

The current fixed policy allows eight failed attempts from one source against
one target in five minutes and blocks that source-target pair for fifteen
minutes. For each source it allows 128 password-work attempts or 1,024
token-work attempts per five minutes, then blocks that source's work class for
five minutes. A successful authentication releases both provisional
reservations. Git's ambiguous password-or-token Basic credential uses one
password-work reservation because its compatibility path performs PBKDF2
before trying a user token.

One source can no longer lock another source out of a target or exhaust its
work budget. Cloudflare WAF/source limiting remains a public-registration gate
as defense in depth against distributed abuse, rotating botnets, shared-source
pressure, and traffic that reaches the fixed unavailable-source scope.

First-run commissioning claims a durable one-shot state before bootstrap or
account mutations begin. Concurrent setup requests are rejected. An interrupted
attempt that may have changed external or authentication state remains blocked
for explicit recovery instead of replaying setup over partially written state.

The CLI stores local credentials in `~/.config/gsv/config.toml`. On Unix it
writes the file as `0600` and ignores cached session tokens if the file is
group/world-readable.

## Secrets and Runtime Config

Deployment secrets live in Cloudflare configuration and bound services. Runtime
configuration lives in Kernel SQLite under `config/...` and `users/{uid}/...`.
Sensitive config names such as `api_key`, `secret`, `token`, and `password` are
filtered from non-root config reads.

OAuth account credentials live in Kernel SQLite, separate from runtime config.
The public syscall surface exposes account summaries only; access tokens,
refresh tokens, and PKCE verifiers are not returned by `sys.oauth.*`. MCP server
tokens are managed by the Kernel Agent MCP client manager; GSV keeps separate
user ownership metadata so MCP listing and tool calls are scoped before
CodeMode or shell can use them.

Agent processes receive the AI runtime configuration they need to call the
selected model provider, including the resolved provider key. That key is used
by the process runtime; it is not sent to CLI devices as part of normal device
routing. Treat root access, package review, process prompts, and model-provider
trust as part of the secret boundary.

## Authorization

Capabilities are group based. The Kernel stores grants such as `fs.*`,
`shell.*`, `proc.*`, `sys.config.get`, or `*` in `group_capabilities`. Every
normal syscall is rejected unless the caller's resolved capabilities match the
exact syscall, the syscall domain wildcard, or `*`.

The full `*` capability is reserved for gid `0`; migrations remove it from any
non-root group and account provisioning rejects it. Object-level root checks
use uid `0`, not possession of a capability string.

Default groups are intentionally OS-like:

- `root` (`gid 0`) receives `*`.
- `users` (`gid 100`) receives broad user capabilities, including filesystem,
  shell, process, package, repository, adapter status/connect, OAuth, token,
  workspace, and config syscalls.
- `drivers` (`gid 101`) receives `fs.*` and `shell.*` for device execution.
- `services` (`gid 102`) receives `adapter.*`.

Capabilities are necessary but not always sufficient. Handlers also enforce
object ownership. Non-root users can access only their own processes and
workspaces. Non-root config reads include their own `users/{uid}/...` keys and
non-sensitive `config/...` keys; sensitive key names such as `api_key`,
`secret`, `token`, and `password` are hidden. Non-root config writes are limited
to user-overridable `users/{uid}/ai/...` keys.

## Files and Shell

Native GSV file access uses a virtual filesystem. `/sys`, `/proc`, `/dev`, and
`/etc` expose Kernel state; `/workspaces/{workspaceId}` is workspace-backed;
ordinary paths are stored in R2 with Unix-like uid/gid/mode metadata. Root can
read/write broadly. Non-root reads and writes are checked against owner, group,
and other mode bits where the backend supports them.

Explicit R2 directory markers enforce ancestor traversal, directory listing,
and parent mutation permissions. Object and marker updates use R2 ETag
preconditions so concurrent create or replace operations cannot silently seize
ownership after authorization. Marker objects are not user-addressable files.
Deletion first replaces the exact authorized ETag with a mode-`000` claim, so
R2's unconditional delete cannot erase a concurrent replacement.

Process media, package runtime artifacts, and process source overlays are
internal R2 namespaces and are not mounted into a non-root process filesystem.
`/public` remains readable but is root-managed. Non-root callers cannot search
the raw filesystem root or `/home`, which would bypass account-home routing.

Device file tools and shell tools are not a sandbox. Relative paths resolve
against the device workspace, but absolute paths are used as-is on the device.
`shell.exec` runs with the OS permissions of the user running `gsv device`.
Run device daemons as an unprivileged account and point their workspace at the
smallest useful directory.

Tool approval is a policy layer, not an isolation layer. Profiles can auto,
deny, or ask for matching syscalls. The default interactive policy asks for
`shell.exec`, `fs.delete`, and `sys.mcp.call`; non-interactive profiles cannot
pause for human approval.

## Devices

Devices register with a hardware descriptor: device id, owner uid, platform,
version, and an `implements` list such as
`["fs.*", "shell.exec", "net.fetch"]`.

`fs.*`, `shell.exec`, and `net.fetch` are hardware-routable. `target: "gsv"`
runs the native implementation. A device target is forwarded only when:

- The caller can access the device by root, owner uid, or device group ACL.
- The device is online.
- The device advertises an implementation matching the syscall.
- A live driver WebSocket exists for that device id.

The forwarded request keeps the same syscall shape. Agents always see the same
tools; `target` selects the hardware.

## Adapters and External Actors

Adapters bridge external messaging systems into GSV. Inbound adapter calls
require a service identity. External actors are not automatically users: an
actor must be linked to a local uid before messages are delivered to that user's
processes.

For unlinked actors, direct messages receive a link challenge such as
`gsv auth link CODE`. Non-DM messages from unlinked actors are dropped. Once
linked, adapter messages are delivered to the user's routed process or their
`init:{uid}` process. Pending human-in-the-loop approvals can be answered from a
linked DM surface.

Link codes use cryptographic randomness, expire after a short lifetime, and are
single use. Failed consumption is durably limited per user and across the
Kernel; external failures retain one generic invalid-or-expired shape.

## Packages, Apps, and Git

Packages run as installed GSV software, not ambient code. Package app RPC calls
must come through an app session, target an enabled package, and match a syscall
declared by the package entrypoint. The Kernel executes those syscalls as the
authenticated user and still applies normal syscall/device/resource checks.

Assembler artifacts are untrusted input. The Kernel recomputes their canonical
SHA-256 identity, validates module and public-file shape again whenever an
AppRunner loads them, and confines public bytes to the verified artifact's
content-addressed `/public/gsv/packages/<hash>/` subtree. Writes are create-only;
an existing object is accepted only when both its bytes and metadata match.
New loader records are explicitly versioned and always retain public-file
definitions, so their full canonical hash is reverified at load. Already
persisted records from the older loader format omitted those definitions after
hashing. They remain readable only through an unversioned, omission-only
compatibility path that validates the canonical requested and claimed hash plus
all retained module structure, but cannot reconstruct the original full digest.
Migration must reassemble the full artifact from trusted package source, verify
that its canonical digest equals the installed hash, and conditionally replace
the exact legacy loader object with the versioned record. The compatibility
path is removed after upgraded ships have no legacy records left.

Non-builtin packages require review before they can be enabled. Package metadata
records requested bindings and egress grants; default egress is `none`.
Mutating package operations require root or ownership of the user package
scope.

Git HTTP uses Basic auth with either password or user token credentials. Public
repository reads are allowed only for repos explicitly marked public. Package
source repositories are readable only when their package is visible to the
caller. Pushes require the repo owner or root.

## What GSV Does Not Protect Against

GSV does not protect against a compromised Cloudflare account, deployed Worker,
R2 bucket, Durable Object state, ripgit service, or LLM provider. It does not
turn device execution into a container or VM sandbox. It does not prevent a
trusted/root user, approved package, linked external actor, or prompt-injected
agent from requesting dangerous work if policy allows the syscall.

Security depends on operational discipline:

- Use strong passwords and prefer scoped, expiring tokens for automation.
- Bind device tokens to the expected device id.
- Revoke unused tokens with `gsv auth token revoke`.
- Run `gsv device` as an unprivileged OS user.
- Treat package review as code review, especially for shell, filesystem,
  adapter, and network behavior.
- Link adapter actors intentionally and use HIL policies for destructive or
  remote work.

## See also

- [The Adapter Model](./adapter-model.md)
- [Connect Devices](../how-to/connect-devices)
- [Configuration Reference](../reference/configuration.md)
