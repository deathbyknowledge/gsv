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

The CLI stores local credentials in `~/.config/gsv/config.toml`. On Unix it
writes the file as `0600` and ignores cached session tokens if the file is
group/world-readable.

## Secrets and Runtime Config

Deployment secrets live in Cloudflare configuration and bound services. Runtime
configuration lives in Kernel SQLite under `config/...` and `users/{uid}/...`.
Sensitive config names such as `api_key`, `secret`, `token`, and `password` are
filtered from non-root config reads.

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

Default groups are intentionally OS-like:

- `root` (`gid 0`) receives `*`.
- `users` (`gid 100`) receives broad user capabilities, including filesystem,
  shell, process, package, adapter status/connect, token, workspace, and config
  syscalls.
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

Device file tools and shell tools are not a sandbox. Relative paths resolve
against the device workspace, but absolute paths are used as-is on the device.
`shell.exec` runs with the OS permissions of the user running `gsv device`.
Run device daemons as an unprivileged account and point their workspace at the
smallest useful directory.

Tool approval is a policy layer, not an isolation layer. Profiles can auto,
deny, or ask for matching syscalls. The default interactive policy asks for
`shell.exec` and `fs.delete`; non-interactive profiles cannot pause for human
approval.

## Devices

Devices register with a hardware descriptor: device id, owner uid, platform,
version, and an `implements` list such as `["fs.*", "shell.exec"]`.

Only `fs.*` and `shell.exec` are hardware-routable. `target: "gsv"` runs the
native implementation. A device target is forwarded only when:

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

## Packages, Apps, and Git

Packages run as installed GSV software, not ambient code. Package app RPC calls
must come through an app session, target an enabled package, and match a syscall
declared by the package entrypoint. The Kernel executes those syscalls as the
authenticated user and still applies normal syscall/device/resource checks.

Non-system packages require review before they can be enabled. Package metadata
records requested bindings and egress grants; default egress is `none`.
Mutating package operations require root, wildcard capability, or ownership of
the user package scope.

Git HTTP uses Basic auth with either password or user token credentials. Public
repository reads are allowed only for repos explicitly marked public. Pushes
require the repo owner, root, or wildcard capability; `system/*` repositories
are root-only for writes.

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
