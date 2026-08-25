# Security Model

> Status: security contract for the username-sharded Kernel architecture.
> Existing deployments retain `singleton` as the Master and provision fresh
> user runtimes in place; public registration remains closed until the
> multiuser release gates pass.

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

Kernel Durable Objects are the trusted control plane. The Kernel named
`singleton` is the Master Control Program and owns permanent account-name and
uid/gid allocation, password/token verification, groups, capabilities,
cross-user grants, provisioning, and the current package/configuration records.
Admission remains closed and unimplemented. An active Kernel named
`user:<canonical-username>` owns that human's connections, sessions, devices,
process registry, routes, schedules, and OAuth/MCP state. It reads current
Master-owned authority through narrow typed RPCs and stores no durable account,
capability, configuration, package, repository, or link copy.

Process Durable Objects run agent loops under a Kernel-issued process identity
and retain the owning user-Kernel route.
AppRunner Durable Objects run installed package code. CLI devices run on user
machines and execute only the syscalls they advertise, but local OS permissions
remain the final boundary on those machines.

## Authentication

`sys.connect` is the WebSocket login syscall. `/ws` serves commissioning only.
Provisioned clients connect to `/ws/<canonical-username>`, which deterministically addresses
`user:<canonical-username>`, and then authenticate as one of three roles:

- `user`: interactive clients and user tokens; password auth is allowed.
- `driver`: CLI devices; token auth is required and may be bound to one device
  id.
- `service`: adapter/service workers; token auth is required.

The path is a locator, not identity. The Gateway canonicalizes it, and the user
Kernel requires `sys.connect` credentials for the same canonical account. It
checks its persisted username, uid, and active provisioning marker, then asks
`singleton` to verify the password or token. Arbitrary Durable Object names
exist on demand, so the Gateway first checks the Master placement and an unknown
object never bootstraps itself. The Master may idempotently complete a known
`provisioning` placement before selection; only `active` accepts scoped
authentication. Unknown or unsuccessfully provisioned placements return HTTP
404 before upgrade; credential failures occur inside the socket. Canonical
usernames are public, so username non-enumerability is not promised.

Setup mode on `/ws` accepts only commissioning syscalls until the first
user/root credential and user-Kernel provisioning state are created. Passwords
are stored in Master Control Program `/etc/shadow` form using salted
PBKDF2-SHA-512 hashes. Issued tokens are stored there hashed with high-entropy
token-prefix metadata, optional expiry, revocation state, allowed role, and
optional device binding. Raw tokens are returned only at creation time.

Password, token, and Git Basic-auth failures use one external
`Authentication failed` result for missing, locked, expired, revoked, or
incorrect credentials. Password verification uses the normal PBKDF2 work even
when the username or password record is absent. Before verification, the Master
Control Program durably reserves both a source-and-target failure budget and a
source-and-work-class budget in SQLite. The Gateway takes the edge-authored
`CF-Connecting-IP` value and the Master Control Program immediately converts it
to a daily HMAC-SHA-256 pseudonym using a random per-ship secret. The secret stays stable;
the UTC-day epoch is included in the signed input and persisted scope so source
pseudonyms rotate without a secret-rotation race. Missing, malformed, or
oversized source headers use one fixed unavailable-source scope. Raw source
addresses, attempted usernames, and credentials are never stored in the
limiter. Target keys contain a SHA-256 hash of normalized username input.
Password and token work have separate per-source ceilings, while one
source-and-target budget spans both credential kinds so changing credential or
client role cannot bypass it.

Canonical usernames use the account grammar: lower-case ASCII, at most 32
characters, immutable, and permanently reserved. Boundary input is trimmed,
required to match raw ASCII `[A-Za-z_][A-Za-z0-9_-]{0,31}`, and then
ASCII-lowercased. Raw non-ASCII input is rejected before case conversion;
malformed or oversized representations share one fixed invalid limiter target
and never reach username-derived hashing or database lookup. Canonical
usernames cannot be renamed or reused; mutable presentation belongs in GECOS or
another display-name field.

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
Cloudflare's Workers Rate Limiting binding may shed edge bursts, but its
per-location, asynchronously updated counters do not replace these durable
Master limits for an authentication decision.

First-run commissioning on `/ws` claims a durable leased state before bootstrap
or account mutations begin. Concurrent setup requests are rejected. The exact
same normalized request can resume after a retryable failure or expired lease;
it reuses the reserved uid and reconciles already-created credentials, home
state, tokens, and user-Kernel provisioning checkpoints. A request with
different inputs cannot take over that commissioning record.

The CLI stores local credentials in `~/.config/gsv/config.toml`. On Unix it
writes the file as `0600` and ignores cached session tokens if the file is
group/world-readable.

## Secrets and Runtime Config

Deployment secrets live in Cloudflare configuration and bound services.
Both ship-wide `config/...` values and authoritative personal
`users/{uid}/...` values live only in Master Control Program SQLite. User
Kernels forward `sys.config.get` and `sys.config.set` and other internal config
reads to the Master. Non-root reads use a positive allowlist of deliberately
shared system settings. Unknown `config/...` keys and credential-bearing
settings remain Master/root-only even when their names do not resemble a
conventional secret.

OAuth account credentials live in the owning user Kernel SQLite, separate from
runtime config.
The public syscall surface exposes account summaries only; access tokens,
refresh tokens, and PKCE verifiers are not returned by `sys.oauth.*`. MCP server
tokens are managed by the owning user Kernel Agent MCP client manager; GSV keeps
separate user ownership metadata so MCP listing and tool calls are scoped before
CodeMode or shell can use them.

Each `oauth_flows` row binds the human Kernel owner that admitted it. Generic
authorization-code callbacks route to the candidate Kernel by canonical
username, then verify that exact owner and atomically consume the full opaque
state before the bounded provider exchange and credential commit. A missing
owner fails closed; the run-as uid and routing locator are never used to guess
one.

Agent processes receive the AI runtime configuration they need to call the
selected model provider, including the resolved provider key. That key is used
by the process runtime; it is not sent to CLI devices as part of normal device
routing. Treat root access, package review, process prompts, and model-provider
trust as part of the secret boundary.

## Authorization

Capabilities are group based. The Master Control Program stores grants such as
`fs.*`, `shell.*`, `proc.*`, `sys.config.get`, or `*` in
`group_capabilities`. Every normal syscall is rejected by the owning user Kernel
unless the caller's Master-issued capabilities match the exact syscall, the
syscall domain wildcard, or `*`.

`account.get` is the identity-resolution surface: it returns the canonical
account record and exposes run-as fields such as capabilities or
`personalAgentUid` only when the caller may delegate to that account.
`sys.cap.list` returns current Master-owned capability grants filtered to the
caller's visible groups. Neither result is persisted as a user-Kernel authority
store.

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
object ownership. A non-root human and processes run by that human see only the
human's owner-scoped processes and runtime state. Personal and owned agents use
their own uid/gids for Unix and device permissions, but human-owned control
plane state such as OAuth, tokens, links, and schedules remains scoped to the
controlling human. Non-root config reads include the run-as account's own
namespace, the controlling human's user-overridable keys, and only explicitly
shared `config/...` keys. A new system key is private by default until its
semantics are reviewed and added to that allowlist. Non-root config writes are
limited to authorized user-overridable `users/{uid}/ai/...` keys.

## Files and Shell

Native GSV file access uses one virtual filesystem across the ship. `/sys`,
`/proc`, `/dev`, and `/etc` expose authorized Kernel state;
`/workspaces/{workspaceId}` is workspace-backed; ordinary paths are stored in a
shared R2 bucket with Unix-like uid/gid/mode metadata. Root can read/write
broadly. Non-root reads and writes are checked by GsvFs against owner, group, and
other mode bits. R2 neither interprets nor enforces those metadata values, and
per-user prefixes are not the permission boundary.

Explicit R2 directory markers enforce ancestor traversal, directory listing,
and parent mutation permissions. Object and marker updates use R2 ETag
preconditions so concurrent create or replace operations cannot silently seize
ownership after authorization. Marker objects are not user-addressable files.
Deletion first replaces the exact authorized ETag with a mode-`000` claim, so
R2's unconditional delete cannot erase a concurrent replacement.

Process media, package runtime artifacts, and process source overlays are
internal R2 namespaces and are not mounted into a non-root process filesystem.
`/public` remains readable but is root-managed. `/home` is a virtual account
directory: it lists the caller's runnable accounts plus registered account
homes whose explicit directory marker grants read and execute access. Paths
inside those homes still use the caller's uid/gids and ordinary Unix mode bits;
seeing a username never grants file access. Non-root callers cannot search the
raw filesystem root, which would bypass the mounted authorization boundaries.

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

Devices connect through `/ws/<owner-username>` and register with that user's
Kernel using a hardware descriptor: device id, owner uid, platform, version, and
an `implements` list such as
`["fs.*", "shell.exec", "net.fetch"]`.

`fs.*`, `shell.exec`, and `net.fetch` are hardware-routable. `target: "gsv"`
runs the native implementation. A device target is forwarded only when:

- The caller can access the device by root, owner uid, or device group ACL.
- The device is online.
- The device advertises an implementation matching the syscall.
- A live driver WebSocket exists for that device id in the owning user Kernel.

The forwarded request keeps the same syscall shape. Agents always see the same
tools; `target` selects the hardware.

These checks apply to the device registry owned by the selected user Kernel.
`user:root` cannot yet discover or route devices owned by another user Kernel.
Cross-shard root administration and group/ACL device forwarding remain
multiuser release gates and fail closed today.

## Adapters and External Actors

Adapters bridge external messaging systems into GSV. Inbound adapter calls
require a service identity. External actors are not automatically users: an
actor must be linked to an immutable canonical username and uid before messages
are delivered through that user's Kernel to their processes.

The Master Control Program owns global adapter-account/link uniqueness. It
routes adapter traffic in both directions today. For inbound work, the scoped
Gateway entrypoint calls the Master with the normalized frame. The Master
validates bounded adapter/account/actor/surface fields and resolves the current
identity link. It idempotently completes a known `provisioning` owner placement
and invokes only the resulting active user Kernel. The target verifies the
Master source and its own username/uid marker before delivery. Payload usernames
never select a Kernel.

For outbound replies, the user Kernel presents the stored adapter run route to
the Master. The Master rechecks the active owner, adapter account, external
actor, surface, and monotonic link revision before invoking the adapter worker.
If measured traffic makes this path material, a short-lived in-memory cache may
be populated and invalidated by Master push; it must never become a durable
link-authority store.

For unlinked actors, direct messages receive a link challenge such as
`gsv auth link CODE`. Non-DM messages from unlinked actors are dropped. Once
linked, adapter messages are delivered to the user's routed process or their
`init:{uid}` process in the owning user Kernel. Pending human-in-the-loop approvals can be answered from a
linked DM surface.

Link codes use cryptographic randomness, expire after a short lifetime, and are
single use. Failed consumption is durably limited per user and across the
Kernel; external failures retain one generic invalid-or-expired shape.

## Packages, Apps, and Git

Packages run as installed GSV software, not ambient code. Package app RPC calls
must come through an app session, target an enabled package, and match a syscall
declared by the package entrypoint. The owning user Kernel executes those
syscalls as the authenticated user and still applies normal
syscall/device/resource checks.

An active app-session route has the bounded form
`gsv1b~username~uid~expiresAt~nonce~signature`. The signature is a local
user-Kernel HMAC over the locator fields. The Gateway parses the canonical
username and bounds to select `user:<username>`; the target then checks its
active marker, HMAC, expiry, launch/client secret, and exact local session. A
forged route may wake only the bounded named object and fails there without
acquiring authority. Active app request and response bodies bypass `singleton`.

One deterministic `app:<actorUid>:<packageId>` AppRunner owns package
runtime, live sockets, daemon schedules, and package-reachable SQLite for that
ship-global actor uid and package. Its name is a locator, not authority. The
active user Kernel validates the current run-as account, enabled/reviewed
package, artifact hash, entrypoint, and requested call against the Master
before admitting package work. AppRunner re-entry into the platform carries an
exact app frame and is reauthorized through that user Kernel.

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
the exact older loader object with the versioned record. The compatibility path
is removed after upgraded ships have no unversioned records left.

Non-builtin packages require review before they can be enabled. Package metadata
records requested bindings and egress grants; default egress is `none`.
Mutating package operations require root or ownership of the user package
scope.

Git HTTP uses Basic auth with either password or user token credentials. Public
repository reads are allowed only for repos explicitly marked public. Package
source repositories are readable only when their package is visible to the
caller. Pushes require the repo owner or root.

Git authentication is a bounded Master admission check, not a repository data
path. For an authenticated request, the Master applies the durable abuse limit,
runs the bounded password-or-token verifier, and checks the exact username,
uid, active placement, capabilities, repository owner, and ACL. Unknown or
non-active accounts receive bounded verifier work and the same generic external
authentication shape but cannot be admitted as that identity. An explicitly
public read may still proceed anonymously. Once admitted, the Gateway sends the
original request directly to RIPGIT; neither its body nor repository response
data transits a Kernel.

## What GSV Does Not Protect Against

GSV does not protect against a compromised Cloudflare account, deployed Worker,
R2 bucket, Master or user Kernel state, ripgit service, or LLM provider. It does not
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
