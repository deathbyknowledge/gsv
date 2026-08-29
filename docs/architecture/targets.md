# Targets and Capability Environments

A GSV target is an addressable, Unix-shaped capability environment. It may be
backed by the native GSV runtime, a physical computer, a browser profile, or an
external service account.

This is the target abstraction. A target is not defined by hardware, a process
boundary, or a particular transport. It is defined by the coherent environment
it makes available through GSV primitives.

"Unix-shaped" means familiar resources and composition: stable paths where a
filesystem is meaningful, commands with ordinary input and output, streams for
large bodies, explicit cancellation, and small operations that scripts can
combine. It is a design shape, not a promise of POSIX compatibility and not a
requirement that every target implement every syscall.

## Peer, target, machine, and adapter

These terms describe independent roles:

| Term | Meaning |
|---|---|
| **Peer** | A live protocol participant with a principal, grants, transport, provenance, and implemented syscalls. |
| **Target** | An addressable capability environment offered through coherent GSV primitives. |
| **Machine** | A physical or virtual computer that may provide one hardware-backed target. |
| **Adapter** | The owner of an external messaging protocol, account state, identity normalization, and delivery behavior. |

A peer may offer no target, one target, or multiple targets. A target may be
reached through a WebSocket endpoint, a Worker service binding, or a native
Kernel implementation. Transport does not determine the environment's meaning
or authority.

An adapter is not automatically a target. A transport-only Telegram account,
for example, may expose only inbound and outbound messaging. An adapter account
that also provides a coherent environment may independently offer a target.
Slack or Discord could expose conversations and files as resources plus
provider actions as composable commands while the same adapter continues to own
webhook verification and canonical message delivery.

## The coherence contract

Target routing is useful only while the same primitive keeps the same meaning:

- `fs.read` addresses a stable resource namespace and returns the normal file
  or directory result, including a stream when bytes are involved.
- `fs.search` searches that namespace rather than disguising an unrelated API
  query as a filesystem operation.
- `shell.exec` runs a command environment with defined arguments, working
  directory behavior, output, exit status, timeout, and cancellation semantics.
- `net.fetch` performs the same HTTP operation from the selected environment's
  network position.

A target may implement only the primitives it can honor. Provider-specific
commands can live inside a real target shell, just as the browser target offers
`tabs`, `page`, `network`, and `storage` commands. A provider should use an
ordinary syscall, CodeMode function, or MCP tool instead when no coherent
filesystem or command environment exists. Target-ness is not a reason to turn
every remote API into pretend POSIX.

## Current target providers

GSV currently projects these environments:

- `gsv` is the native cloud target. Its provider owns `fs.*`, `shell.exec`, and
  `net.fetch` through `GsvFs`, the just-bash command environment, and the
  Worker's network position. Kernel control-plane syscalls remain outside that
  provider.
- `gsvd` registers physical computers and implements filesystem, shell, network,
  and host operations using that computer's local environment.
- The browser extension registers a browser profile as a pseudo-computer. It
  implements `fs.*` and `shell.exec` over a virtual filesystem and
  browser-specific commands even though the browser is not an operating-system
  machine.
- Managed Slack projects a personally authorized workspace as a service-backed
  `shell.exec` target. Its ephemeral just-bash environment exposes a composable
  `slack` CLI for conversations, threads, messages, reactions, and users. The
  paired user's OAuth token supplies read visibility; mutations use the
  installed GSV app identity, and the adapter retains both credentials and
  provider policy.

The persisted registry and compatibility syscalls still use `device` names for
non-native targets. That is an implementation and upgrade constraint, not the
architectural definition of a target.

The native provider runs in-process and is not a synthetic protocol peer or a
device-registry record. The Kernel selects it through the same `target`
boundary, while external providers additionally require routing, liveness, and
transport ownership.

Telegram, WhatsApp, Discord, standalone Slack, and other adapter deployments
remain transport-only until each has truthful account authority and coherent
environment semantics. Adapter target support is optional and advertised by the
service descriptor; transport support alone never creates one.

## Adapter-backed targets

An adapter-backed target must keep two paths distinct:

1. The messaging projection admits inbound human messages and delivers
   canonical GSV Messages through normalized adapter surfaces.
2. The target projection performs external service work such as searching
   workspace history, reacting to a message, managing a thread, or transferring
   a provider file.

`message send` remains the operation that commits a user-visible GSV Message and
delivers it to a conversation surface. A command executed on a Slack target is
ordinary external tool activity, even when that command also posts to Slack.

The adapter continues to own provider credentials, OAuth scopes, platform
identifiers, rate limits, retries, idempotency, formatting, and relink fences.
The Kernel owns the caller's GSV capability check, target visibility, generic
routing, cancellation, and body ownership. Provider identifiers must not become
bearer capabilities merely because the provider also offers a target.

Managed shared credentials require special care. Pairing a human proves the
right to enter GSV from the paired identity and observed surfaces; it does not
automatically grant that person's GSV every workspace resource visible to a
shared bot token. A rich service target needs authority that actually matches
its advertised environment, such as a user OAuth connection or an explicitly
installation-owned administrative account.

Authority and authorship must remain independent inside a service target. A
personally authorized Slack target may borrow that person's visibility without
silently writing as them. Its write commands use the installed app identity;
private resources remain read-only until the user explicitly admits that app.
Target-originated messages must visibly attribute the paired person's GSV even
though the provider records the installed app as their technical author.

## Target discovery and lifecycle

Targets should describe their environment and effective implementations so a
process can discover where work belongs without loading provider-specific tools
into its fixed interface. Registration or connection never grants authority by
itself: the Kernel intersects caller capabilities, target ACLs, effective
implementations, and current availability before routing work.

Disconnect, timeout, cancellation, and replacement must terminate in-flight
routes and bodies at the component that owns them. A late response from an old
peer session or adapter-account generation must never mutate or satisfy work on
its replacement.

## Related architecture

- [Unified Protocol Peers](./unified-protocol-peers.md)
- [The Adapter Model](./adapter-model.md)
- [Security Model](./security-model.md)
- [Routing Reference](../reference/routing.md)
- [Target Tools Reference](../reference/hardware-tools.md)
