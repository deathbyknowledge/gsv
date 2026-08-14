# Security Model

GSV is powerful personal infrastructure. It can run agent processes, execute
shell commands, read and write files, connect external devices, and send
messages through adapters. Its security model is therefore
closer to a small Linux-like computer than to a chatbot API.

The core rule is simple: callers authenticate as an identity, receive group
capabilities, and issue syscalls. The Kernel checks those capabilities and then
applies resource-specific rules for files, processes, devices,
adapters, and repositories.

## Trust Boundaries

The Cloudflare account and deployed bindings are the root of trust. Anyone who
can change Worker code, Durable Object state, Worker secrets, R2 buckets, or
bound services can effectively control the GSV instance.

The Kernel Durable Object is the trusted control plane. It owns users, groups,
tokens, capabilities, config, devices, process registry, workspaces, adapter
links, routing tables, and repository visibility in Kernel SQLite.

Process Durable Objects run agent loops under a Kernel-issued process identity.
CLI devices run on user machines and execute only the syscalls they advertise,
but local OS permissions remain the final boundary on those machines.

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

For a managed installation, the private accounts operator reserves the hostname
and issues a one-time onboarding capability in the URL fragment. The browser
moves that capability to tab-scoped storage before making requests. The
accounts Worker stores only its hash and binds it to one provisioning
installation; the Kernel validates it over a private service binding before
accepting `sys.setup` or `sys.setup.assist`. Local usernames and passwords never
belong to the accounts directory. They are created and authenticated only by
that installation's Kernel. Successful setup consumes the claim and activates
the hostname.

Accounts remains the source of truth for the managed installation lifecycle.
Suspending an active installation changes it to `restricted` without releasing
its hostname or deleting its state. New hostname requests disappear behind the
same not-found boundary used for other inactive installations, and existing
WebSocket sessions receive a `423` error when they attempt another call.
Adapter ingress, managed inference, Process ticks, and due schedules also check
the installation state. An operation already admitted may finish its current
step; durable Process and schedule work remains pending and rechecks after
reactivation.

The accounts directory and onboarding methods are available only through a
service binding. Cloudflare Access protects its public operator page at
`https://gsv.space/admin`; it is not a customer login system. The registry
principal and pending membership are control-plane bookkeeping and are not
mapped to a Kernel uid during onboarding.

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
routing. Treat root access, process prompts, and model-provider
trust as part of the secret boundary.

## Authorization

Capabilities are group based. The Kernel stores grants such as `fs.*`,
`shell.*`, `proc.*`, `sys.config.get`, or `*` in `group_capabilities`. Every
normal syscall is rejected unless the caller's resolved capabilities match the
exact syscall, the syscall domain wildcard, or `*`.

Default groups are intentionally OS-like:

- `root` (`gid 0`) receives `*`.
- `users` (`gid 100`) receives broad user capabilities, including filesystem,
  shell, process, repository, adapter status/connect, OAuth, token,
  workspace, and config syscalls.
- `drivers` (`gid 101`) receives `fs.*` and `shell.*` for device execution.
- `services` (`gid 102`) receives `adapter.*`.

Capabilities are necessary but not always sufficient. Handlers also enforce
object ownership. Non-root users can access only their own processes and
workspaces. Non-root config reads include their own `users/{uid}/...` keys and
non-sensitive `config/...` keys; sensitive key names such as `api_key`,
`secret`, `token`, and `password` are hidden. Non-root config writes are limited
to user-overridable `users/{uid}/ai/...` keys.

An owned agent retains its own process identity for context, home, and
provenance, but uses the owning human's authority for user-scoped resources.
The human and all of their agents may therefore access the human's home and the
homes of agent accounts that human may run as. Homes outside that ownership
boundary remain inaccessible. Capabilities and tool approvals still apply.

## Files and Shell

Native GSV file access uses a virtual filesystem. `/sys`, `/proc`, `/dev`, and
`/etc` expose Kernel state; `/workspaces/{workspaceId}` is workspace-backed;
ordinary paths are stored in R2 with Unix-like uid/gid/mode metadata. Root can
read/write broadly. Non-root reads and writes are checked against owner, group,
and other mode bits where the backend supports them.

Device file tools and shell tools are not a sandbox. Relative paths resolve
against the device workspace, but absolute paths are used as-is on the device.
`shell.exec` runs with the OS permissions of the user running `gsv device`.
Run device daemons as an unprivileged account and point their workspace at the
smallest useful directory.

Tool approval is a policy layer, not an isolation layer. Profiles can auto,
deny, or ask for matching syscalls. The default interactive policy asks for
`shell.exec`, `fs.delete`, `sys.mcp.call`, and `mail.send`; non-interactive
profiles cannot pause for human approval.

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
linked, a direct message is delivered to the user's personal controller unless
that controller opened a direct line to an owned work process from the exact
current DM run. A newer private message or selection fences a late route
change, and `/home` always returns the surface to personal intelligence. A
linked group, channel, or thread follows its actor-scoped route; the first
message on an unrouted shared surface creates a separate interactive process.
Pending human-in-the-loop approvals can be answered from a linked DM surface.

Managed email is installation-addressed rather than actor-linked. The public
recipient handle is resolved through Accounts, and only an active directory
record can select the immutable installation ID used to address email and
Kernel Durable Objects. The email adapter owns SMTP intake, quotas, retry state,
and temporary raw outbox chunks. The Kernel owns the canonical mailbox and
assigns it to one local human account; filesystem and shell authorization then
apply normally.

Inbound email is hostile content. The Kernel persists exact bytes before any
inference call. Summarization uses a fixed server-owned model and prompt with no
tools, and only its validated bounded result becomes a typed system event for
the owner's Personal intelligence. The event omits separate mailbox
identifiers, address fields, display names, subjects, raw headers, and bodies.
Personal handles it in a notification-only run with tool, MCP, and device
execution disabled. This reduces the instruction-injection surface but does not
make the sender, links, attachments, or summary trusted.

Explicit outbound mail is a capability-gated `mail.send` syscall for one
plain-text recipient. The Kernel ignores caller-supplied sender identity because
the syscall has no `from` argument: it resolves the active human owner and
derives that owner's canonical managed address. The email Worker independently
derives the same expected sender from the active Accounts handle and configured
mail domain before using the provider binding.

CodeMode exposes `mail.send` as a nested syscall, not as a fixed direct tool, and
the default interactive policy asks for approval on each call. The native
`mail send` and `mail reply` commands execute beneath `shell.exec`; the outer
shell approval is their authority and they do not generate a second nested
approval. Policies that auto-approve `shell.exec` therefore also authorize
those shell forms, just as they authorize other shell side effects.

Outbound replay protection spans both trust boundaries. Kernel SQLite binds a
human owner's required, caller-retained `deliveryId` to the exact draft while R2 holds the canonical body.
The installation-scoped email Durable Object durably reserves quotas and marks
the provider attempt before sending. Local lifecycle, quota, and validation
rejections before that attempt are `failed`; a successful provider acceptance
is `accepted`; any binding throw or other ambiguous outcome after the attempt
is `unknown` and is never replayed. Production deployment
keeps outbound sending disabled and its daily message and byte allowances at
zero until the operator completes the Email Sending release gates.

## Git

Git HTTP uses Basic auth with either password or user token credentials. Public
repository reads are allowed only for repos explicitly marked public. Pushes
require the repo owner, root, or wildcard capability.

## What GSV Does Not Protect Against

GSV does not protect against a compromised Cloudflare account, deployed Worker,
R2 bucket, Durable Object state, ripgit service, or LLM provider. It does not
turn device execution into a container or VM sandbox. It does not prevent a
trusted/root user, linked external actor, or prompt-injected agent from
requesting dangerous work if policy allows the syscall.

Security depends on operational discipline:

- Use strong passwords and prefer scoped, expiring tokens for automation.
- Bind device tokens to the expected device id.
- Revoke unused tokens with `gsv auth token revoke`.
- Run `gsv device` as an unprivileged OS user.
- Link adapter actors intentionally and use HIL policies for destructive or
  remote work.

## See also

- [The Adapter Model](./adapter-model.md)
- [Connect Devices](../how-to/connect-devices)
- [Configuration Reference](../reference/configuration.md)
