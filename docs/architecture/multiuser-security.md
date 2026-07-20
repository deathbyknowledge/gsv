# Multiuser Security Architecture

> Status: implemented username-sharded runtime and release contract. Clean
> commissioning and new privileged human-account creation
> provision user Kernels; v16-upgraded accounts remain on the explicit `legacy`
> singleton path. Package/configuration/repository-metadata authority remains
> intentionally Master-owned; adapter link lookup still uses the live Master;
> legacy state migration, the security-audit ledger, and public admission are
> not implemented. Public registration remains closed until the release gates
> in this document pass.

GSV multiuser support turns one personal computer into a small, internet-facing
ship with several mutually untrusted humans. The ship is intentionally one
Linux-like security domain: one global account and Unix ownership namespace,
one root user, one Master Control Program, and one Kernel coordination shard per
login-capable human. This is a security-boundary change, not only an
account-creation feature.

The Durable Object named `singleton` is the ship's Master Control Program, not a
singleton human. Active user Kernels keep ordinary WebSocket, device, process,
schedule, OAuth, and MCP coordination off that object. Each newly provisioned
human receives a Kernel named `user:<canonical-username>` plus a distinct
account, uid, primary gid, home, credentials, processes, agents, devices, and
external links. The Master Control Program owns global identity and
authorization; the user Kernel enforces that authority and coordinates its
human's steady-state runtime. A logged-in non-root human must not gain ambient
access to another human's resources.

Current transitional exceptions are deliberate and visible: package records,
configuration writes, and normalized repository metadata remain
Master-authoritative and are projected into user Kernels; every adapter inbound
message still uses a live Master link and placement metadata lookup, but active
and unknown-actor payload content bypasses the Master; active app ingress
verifies a Master-issued placement certificate at the edge before selecting a
user Durable Object, then verifies a separate local HMAC and session at the
target; and OAuth/MCP locators are routing hints whose full opaque state is
authorized and consumed only by the target. These are not descriptions of the
final fully projected target.

Ship root is intentionally omnipotent in the security model. GSV must make that
trust relationship clear during registration; it does not claim to isolate
members from the person who owns root or from the deployment operator. The
current sharded runtime deliberately fails closed where cross-shard root
administration is not wired: for example, `user:root` cannot yet enumerate or
route another user Kernel's devices or processes. Those administrative paths
are release-gated implementation work, not a reduction in root's intended
authority.

This document defines the target boundary, threat model, migration sequence,
and release gates. The [Security Model](./security-model.md) defines the shared
authentication, capability, and resource-checking contract, including which
parts remain migration work.

## Security goals

The multiuser design must preserve these properties:

- The ship Kernel named `singleton` is the authoritative Master Control Program
  for the global account-name, uid/gid, group, capability, admission, and
  cross-user namespace. It does not relay model token events, device bodies, or
  user-session payloads. Some steady-state paths still perform bounded
  credential, placement, link, package, or repository metadata checks there;
  those calls never make `singleton` the payload or execution data plane.
- Every login-capable human has one provisioned user Kernel named
  `user:<canonical-username>`. A busy human can load that shard without loading
  another human or the Master Control Program.
- Every canonical username is a lower-case ASCII public account identifier. It
  is immutable, permanently allocated, and never reused. Every uid and gid is
  likewise unique within the ship, permanently allocated, and never reused.
- Every request acquires its canonical username, uid, gids, capabilities, role,
  and resource-specific actor ids from authenticated Kernel state.
  Client-supplied usernames, uids, gids, headers, paths, metadata, or object ids
  do not confer authority.
- Filesystem authorization is the primary cross-user file boundary. Owner,
  group, other, directory traversal, and root semantics are applied consistently
  across every native filesystem operation.
- Private credentials and state for one non-root human are not readable by
  another non-root human, their processes, packages, devices, or adapters.
- Cross-user access is denied unless Unix permissions, an explicit group or
  ACL, or another bounded and revocable resource grant authorizes it.
- Model output, package output, adapter payloads, and device responses are
  untrusted data. None can mint identity, capability, membership, filesystem
  metadata, or route authority.
- Cancellation, revocation, suspension, and credential reset invalidate stale
  routes; late output cannot attach to a new or different principal.
- Public endpoints have deterministic abuse and cost ceilings that run before
  password hashing, model inference, account creation, or other expensive work.

The Cloudflare account, deployed Worker code, bindings, ship root, and storage
remain trusted, as described in the current security model. Unix permissions
protect members from other non-root members. They do not protect against uid
`0`, code that can bypass the authorized storage boundary, or an operator who
can replace code or read bound storage.

## Threat model

Protected assets include password hashes, bearer tokens, provider and OAuth
credentials, private files and repositories, process history and media, package
state, device access, adapter links, membership policy, route state, inference
budget, and the future security-audit records required by the release contract.

The design assumes attacks from:

- an unauthenticated internet client probing usernames, passwords,
  registration, OAuth callbacks, app routes, and webhook routes;
- an authenticated but malicious non-root member trying to cross uid, gid,
  process, package, repository, device, or adapter boundaries;
- prompt injection in an admission statement, message, file, web page, adapter
  event, device description, tool result, or model response;
- a compromised or malicious Process, package, AppRunner, browser app, device,
  adapter account, or external provider;
- a stolen, replayed, confused-audience, or stale session, app, device, OAuth,
  or registration token;
- races during username or uid allocation, admission finalization, permission
  changes, object replacement, revocation, callback completion, and migration;
- accidental direct R2 access that bypasses GSV filesystem authorization.

Denial of service is in scope at the product boundary: public callers must not
have unbounded access to Kernel work, password verification, inference,
storage, or account provisioning. Complete protection from volumetric attacks
outside the deployed Cloudflare controls is not a GSV runtime guarantee.

Root acting deliberately is not an attacker in this model. A ship that needs
to protect humans from its administrator requires a different cryptographic
trust model, such as member-held encryption keys; Unix permissions and R2 key
prefixes cannot provide that property.

## Authority and isolation boundaries

Durable Objects follow the actual coordination atoms. The Master Control
Program owns global identity and authorization. Each user Kernel owns one
human's runtime coordination. Process and AppRunner objects own durable
execution state, but they do not become independent security authorities.

| Component | Authoritative state | Must not own |
| --- | --- | --- |
| Master Control Program (`singleton`) | Ship id; permanent canonical account-name reservations; global uid/gid allocation; account kind and lifecycle; password/token verifiers and login abuse budgets; groups and capabilities; cross-user grants; current package/configuration and repository-metadata authority; global adapter-account/link uniqueness; global budgets; user-Kernel provisioning records and generations; app-placement signing key; future admission and audit state | User WebSockets for active placements; model token events; device bodies or heartbeats; active-user and unknown-actor adapter payload content; active per-user process routing; package execution; repository data-plane work; untrusted model decisions; UI rendering; adapter-specific identity normalization; or device-native work |
| User Kernel (`user:<username>`) | Immutable username/uid binding and provisioning state; authenticated user, device, and service connections for that human; sessions and connection generation; devices; process/conversation registry; user routes and notifications; schedules; OAuth/MCP state; projected package/configuration and repository metadata; local app-route HMAC secret and exact-generation placement certificate | Global username or uid allocation; password/token verification; group/capability expansion; another human's private runtime; root policy; file bytes; process history; package SQLite; or authority inferred from the requested DO name |
| Process DO | One Kernel-issued owner and run-as identity; history; queue; pending tools; approvals; process-local media references | Account creation, uid/gid allocation, group membership, capability expansion, or authority derived from a frame |
| AppRunner control DO (`app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>`) | One exact controlling human Kernel owner, run-as actor, package, and runtime authority; app sessions; daemon schedules; explicitly granted calls | Package-reachable SQLite, another Kernel owner's or actor's session/storage, membership, root authority, or grants broader than the invoking session |
| App data DO (`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>`) | Package-reachable SQLite for exactly one immutable Kernel-owner uid, actor uid, and package tuple | App traffic, sockets, commands, signals, schedules, control tables, or authority inferred from its object name |
| Authorized filesystem boundary | Path resolution; mount routing; caller identity; Unix mode and ownership checks; safe R2 operations | Trust in caller-supplied uid/gid/mode or the assumption that R2 enforces custom metadata |
| Adapter or device | Platform or machine transport state and only narrowly advertised operations | Authority derived from a payload username/uid or a broad ship credential |

Permanent username reservations, uid/gid allocation, membership, group changes,
and cross-user grants require one strongly ordered authority. That authority is
`singleton`; it is not a shared data path. Authentication begins in the
username-addressed user Kernel and uses only narrow Master Control Program calls
for globally authoritative decisions. Model inference, package execution,
process loops, file bytes, repository work, and platform-native operations
remain in their owning services. No Kernel holds a transaction or initialization
lock across inference, R2, ripgit, device, adapter, or other external I/O.

The current deployment boundary is one ship: one Gateway deployment, its Master
Control Program named `singleton`, its `user:<username>` Kernels, and its bound
storage stack. A request cannot select another ship. Future multi-ship hosting
would need a trusted deployment or allowlisted-host mapping plus explicit ship
scope in every Kernel, AppRunner, R2, service, and callback locator; it must
never use a request body or an unverified `Host` value. Separate ships never
merge username or uid/gid namespaces.

Ship administration may be delegated through narrow capabilities, but uid `0`
is different: root is the superuser and bypasses normal ownership and mode
checks. Product surfaces should avoid casual impersonation. A future
security-audit ledger must record root operations; no such ledger exists today,
and the system cannot truthfully promise technical privacy from root.

## Canonical account identity and uid/gid

Every account receives one canonical username. It is the account's public,
durable identity and the routing key for a login-capable human's user Kernel.
Canonical usernames use the lower-case ASCII account grammar, are globally
unique across the ship's account namespace, cannot be renamed, and remain
permanently reserved after account retirement. A mutable human-facing name
belongs in GECOS or another explicit display field and never changes identity or
routing.

The Master Control Program also allocates each account a stable numeric uid and
each group a stable numeric gid. The namespace is global within the ship:

- uid `0` and gid `0` are permanently root;
- system identities and groups occupy reserved ranges;
- every human and agent uid is unique and never reused;
- every private or shared gid is unique and never reused; and
- deleted identities leave permanent minimal reservations for canonical
  username, uid, gid, account kind, and terminal status, with audit continuity
  added when the release-gated security ledger exists.

Numeric uid/gid values are the native filesystem ownership keys because all
filesystem access belongs to the same ship security domain. The canonical
username is the durable public account and user-Kernel routing key. Records
whose security checks are naturally numeric continue to store uid/gid;
cross-boundary authority carries both canonical username and uid and rejects a
mismatch, and the future audit ledger must do the same. Device ids, token ids,
PIDs, adapter account ids, and other typed ids remain distinct. No identifier
supplied by an untrusted client establishes identity.

There is no second account identifier or mutable login alias in front of the
canonical username. For a login-capable human, the mapping to
`user:<canonical-username>` is deterministic. The current Gateway still asks
`singleton` for the authoritative lifecycle and generation before invoking that
object; it performs no second account-identifier translation lookup.

Canonicalization is versioned and shared by commissioning, registration,
Gateway routing, login, Git, and every other username boundary. It trims
surrounding whitespace, rejects raw non-ASCII input, validates
`^[A-Za-z_][A-Za-z0-9_-]{0,31}$`, and then lowercases ASCII. URL routing decodes
the username segment exactly once before canonicalization. Creation atomically
and permanently reserves the canonical value. Because canonical usernames are
identity, GSV offers display-name changes rather than username renames.

Only login-capable human accounts receive user Kernels. Root uses `user:root`
when it logs in. Agent and reserved system accounts remain in the global Unix
account namespace but do not receive user Kernels merely because they have a
username. The `user:` prefix separates user-Kernel object names from
`singleton` and other Durable Object roles without adding an id-translation
lookup.

The Master Control Program stores a permanent account reservation and
provisioning generation. The user Kernel stores its matching marker and exposes
the effective lifecycle `unprovisioned`, `provisioning`, `active`, `suspended`,
or `retired`; absence of a valid marker means `unprovisioned`. `retired` is
terminal. Clearing user-Kernel storage cannot release the Master Control Program
reservation, and an unprovisioned object cannot provision itself from an
internet request.

Login follows this order:

1. The Gateway decodes and canonicalizes the path username, strips
   caller-authored internal headers, and asks `singleton` for the authoritative
   placement. The Master derives a UTC-day HMAC pseudonym from Cloudflare's
   trusted source address; the raw address is not forwarded or persisted in the
   user Kernel.
2. Unknown and non-active placements return HTTP 404 without instantiating an
   arbitrary Durable Object. An active placement selects
   `user:<username>` and carries its exact generation plus the pseudonymous
   source scope in trusted internal headers. This reveals the availability of a
   public username but grants no authority.
3. The user Kernel checks that its durable name, canonical username, uid,
   lifecycle, local marker, route generation, and credential username agree.
   Only `active` continues.
4. The user Kernel sends one narrow authentication request to `singleton`. The
   Master rechecks the active placement and exact generation, reserves login
   budgets, and only then verifies the password or token. Edge WAF limits remain
   defense in depth for distributed abuse.
5. The Master Control Program returns authenticated uid, supplementary gids,
   capabilities, and role without returning credential material.
6. The user Kernel binds the WebSocket state to the returned identity and route
   generation; every later message rechecks that local generation.

The lifecycle registry and target fencing RPC advance the route generation and
close existing user-Kernel sessions. The Master first closes new admission for
that username and drains already-admitted Master operations. The target then
persists its non-active generation marker before it fences local runtime and
exact-acknowledges `proc.abort` from every Process DO registered to the old
generation. The Master commits its new placement only after the target fence
succeeds. Wiring credential reset and group mutation to that transition remains
release-gate work. A username or the ability to address its Durable Object is
never sufficient to recover or retarget an authenticated session.

## Kernel-issued authority context

Whenever work crosses the Gateway, Kernel, Process, AppRunner, adapter, or
device boundary, the receiver needs an unforgeable Kernel-issued authority
context. It may be a signed, short-lived ticket or an opaque reference to
Kernel state; the representation is secondary to the invariants.

An authority context binds at least:

- ship id, immutable canonical account username, uid, supplementary gids, and
  actor/run-as identity;
- issuer and exact audience role and object id;
- connection or session id and request or route purpose;
- allowed syscall or capability subset and bounded resource identifiers;
- issue time, expiry, nonce, credential generation, and route generation; and
- parent context or explicit delegation record when authority was narrowed.

It contains no password, provider key, OAuth token, private prompt, or
unrestricted return address. The receiver verifies integrity, audience, expiry,
generation, and scope before parsing a caller-controlled resource id. Critical
mutations recheck current Master Control Program state. Delegation can narrow
authority but can never change account identity, choose uid/gid, add a group, or
expand capabilities.

The Kernel issues authority for Processes, AppRunners, devices, app sessions,
callbacks, and adapters. Responses follow the route registered for the request,
not a return route supplied in an untrusted frame. A globally meaningful PID,
session id, device id, callback state, or `x-gsv-*` header may select a lookup
candidate but does not authorize dispatch by itself.

Public entrypoints that begin with opaque state still need to select an owning
user Kernel before that Kernel can read its local record. The selected user
Kernel always validates the full local record and caller authority; routing
metadata grants no syscall or resource access by itself.

The current implementation uses three deliberately different forms:

- Active app-session handles bind canonical username, uid, Kernel generation,
  expiry, nonce, and a Master-issued P-256 placement certificate into a
  user-Kernel HMAC. The Gateway validates the certificate with the published
  Master public key before calling `getByName` for the user Kernel. The target
  then validates its exact active marker, local HMAC, and session. Invalid or
  forged placement material therefore cannot wake a caller-selected user DO.
- Generic OAuth state and MCP callback paths carry a parseable
  username/generation locator. The Gateway asks the Master whether that exact
  placement is active, while the target atomically consumes the full
  high-entropy flow state.
- Adapter messages carry no link projection yet. `singleton` resolves bounded
  authoritative identity-link and placement metadata for each message, then
  the Gateway sends the full active-user frame directly to the user Kernel.

An app session without a Kernel generation is compatibility-only: it must be an
exact legacy UUID and the Master must still record that owner as `legacy`.
There is no generation-less active-user fallback.

## Projection ordering and runtime fencing

Package, capability, account-directory, configuration, and repository-metadata
projections are authority-bearing even though they are replaceable copies. The
v21 Kernel migration therefore adds one durable projection clock and fence
record to every Kernel DO:

- `singleton` reserves and commits a monotonically increasing Master projection
  revision. Crash recovery promotes a reserved pending revision rather than
  serving changed authoritative state under an older revision.
- Each user Kernel records the exact canonical username, uid, Kernel generation,
  installed Master revision, and SHA-256 digest of its complete filtered
  snapshot. The same revision with different bytes and any older revision fail
  closed.
- A package-authority mutation persists a package fence before closing
  admission. The Master and every active target abort and drain package-stamped
  Kernel operations, exact-generation Processes, schedules, and registered
  AppRunner work before the mutation. Targets install the exact committed
  revision and digest before the fences clear.
- If prepare, mutation, refresh, or clear is interrupted, the durable fence
  remains. Recovery re-prepares the exact fence, promotes any pending Master
  revision, refreshes every target, and clears from the leaf runtimes inward.
  Availability is sacrificed rather than mixing package authority revisions.

The v22 Kernel migration adds a durable registry for AppRunner objects that
have actually and successfully crossed Kernel authorization. A registry row
binds the exact deterministic control or data object name, the package actor's
canonical username and uid, the controlling human Kernel owner's canonical
username and uid, the package id, and first/last observation times. The Kernel
owner, run-as actor, and package jointly determine the runner name; the Kernel
owner determines which user Kernel may exercise package and lifecycle
authority. A registry write is part of authorization and failure denies the
call. The Kernel does not infer authority from an object name, scan the Durable
Object namespace, or instantiate every possible package object.

Package-projection and user-lifecycle transitions issue one-shot, exact-fence
authorizations only to those registered objects. Each AppRunner persists the
gate and increments a durable, monotonic, never-reused runtime epoch before it
closes admission and sockets, aborts tracked cancelable request, response, and
outbound streams, and deletes the active alarm. It then waits for each tracked
wrapper—including SQL, command, signal, and daemon wrappers—to release before
exact acknowledgement. Loader RPC promises that expose no cancellation handle
are abandoned when the fence aborts their wrapper rather than holding the drain
indefinitely. The underlying promise remains observed, but every Loader key,
entrypoint, package-to-platform call, and re-entry into the AppRunner carries
the exact epoch, so late work from the permanently revoked epoch cannot acquire
current runtime authority. Package code must not detach authority-bearing work
beyond the tracked operation lifetime.

The Kernel clears AppRunners before clearing its own package or lifecycle fence.
Package-fence recovery re-prepares and retries the exact durable fence. A
persisted lifecycle fence is reasserted fail-closed; an exact transition or
activation retry must finish an ambiguous clear window. A mismatched source
Kernel, actor, Kernel owner, package, generation, runner name, fence id, or
action is denied.
For explicit legacy owners, `singleton` fences only the observed legacy
runners. For an active owner, that owner's user Kernel is the source and
authority for the same operation.

## Resource authorization

Every syscall first requires the relevant capability. Object-owning handlers
then enforce uid ownership, group/ACL membership, or another explicit resource
grant. A broad capability such as `fs.*` permits use of that syscall family; it
does not make every file accessible. Possession of `*` is reserved for gid `0`,
and object-level superuser checks use uid `0`.

### Processes and conversations

A Process stores its Kernel-issued owner canonical username and uid, run-as
identity, and owning Kernel object name. The owning Kernel registry separately
binds that PID to the exact active user-Kernel generation; legacy Master
processes retain a null generation. Personal and package agents remain
subordinate to a human owner even when they run under their own uid. Before
handling Process RPCs, authority handshakes, cancellation, or device fetch
results, the user Kernel rechecks the registry generation.

When a lifecycle transition fences generation `N`, the target aborts each
registered generation-`N` Process through an exact authority handshake and
requires a matching acknowledgement. The abort cancels the active provider,
tool, and CodeMode work, records a terminal aborted run, and clears the current
run without promoting queued work while the Kernel is non-active. It does not
delete the Process DO, queued input, conversation history, or process media.

An authorized activation may conditionally rebind a same-owner Process record
only from the exact immediate predecessor generation to the activating
generation. Older, foreign-owner, missing, or otherwise mismatched records stay
stale and fail closed. If activation or schedule rearming fails after commit
starts, the target restores a non-active marker, fences runtime again, and
exact-aborts the activating generation. It preserves those executors instead of
rolling them back or deleting their history and media. This lets a suspended
human resume durable processes without allowing arbitrary stale work or late
output to cross a generation boundary.

Process listing, history, control, IPC, signals, human-in-the-loop replies,
archives, and media verify the caller against the stored owner and current user
Kernel authority. Same-owner IPC is the default. Cross-user IPC requires an
explicit Master Control Program grant and never shares conversation history
implicitly. Late results from a cancelled or superseded run cannot mutate
current process state.

### Packages, AppRunner, and public app routes

AppRunner identity includes the immutable controlling Kernel-owner username/uid,
run-as actor username/uid, and package id so runtime state and sessions cannot
collide across humans or when the same actor runs for different human Kernels.
App sessions and cookies bind username, uid, package, entrypoint, session,
client, capability subset, expiry, and generation. The Gateway strips
caller-authored identity headers and adds trusted runtime context only after the
owning user Kernel resolves the session. The app-session handle carries the
authenticated route locator needed to select that user Kernel; it is not a bare
username and does not grant access without the matching local session.

For an active owner, the locator carries two independent integrity checks.
`singleton` signs the exact username/uid/generation placement with ECDSA
P-256/SHA-256 under a private key retained in Master DO storage. The edge
verifies that certificate before selecting the user Kernel. The user Kernel's
per-object HMAC covers the full locator, including the certificate, expiry, and
nonce; only after that check does it resolve the local app session. Active app
session metadata is resolved at the user Kernel, while admitted request bodies
and response streams flow between the Gateway and AppRunner. None transit
`singleton`.

App signals, daemon state, browser RPC, and public webhook routes remain in that
owner scope. Every HTTP, socket, command, signal, and daemon operation carries
an immutable, request-scoped runtime authority and targets only the versioned
`app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` object. Startup
independently attests the expected control schema and its exact migration
ledger; missing v2 control-schema columns or unrecognized user tables fail
closed. This structural check is defense in depth: the versioned name is the
boundary that proves an old package,
which once had arbitrary SQL in its AppRunner database, could not forge the new
control database before cutover.

Approved package SQL is forwarded to the separate data-only
`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` object. That object
cannot accept HTTP, WebSockets, commands, signals, schedules, or control SQL,
and the control object cannot execute the data-only SQL entrypoint. A public
route has an explicit owner and entrypoint record; the Gateway does not search
for a matching user or trust a username in the route. Package approval grants
only the requested entrypoint capabilities for that owner and cannot inherit
root or wildcard authority.

Every authorized AppRunner-owned route supplies its exact control or data
object name to the Kernel. Successful authorization records the v22 actor,
Kernel-owner, and package binding; failure to record it fails the request. That
observation-based registry is what package and user-lifecycle fences enumerate,
so unused deterministic names are not created merely to close them.

#### AppRunner package-data migration gate

This cutover does not claim to migrate legacy package SQLite. Every old
pre-owner-qualified `app-data:<actorUid>:<packageId>` object and every still
older combined `app:<actorUid>:<packageId>` object remains untouched; no
current authority, traffic, schedule, or storage path may select either
namespace. The corresponding `app-control-v2:` objects are likewise
unreachable. A new
`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` object is a fresh
isolated store. Legacy package SQL is therefore preserved but unavailable until
an explicit migration can inventory ownership, distinguish package tables from
formerly shared control/ledger tables, copy only verified package data, and
publish verification and rollback results. Upgrades must not describe an empty
`app-data-v2:` store as a successful data migration. Any release that promises
continuity for existing package SQL is blocked until that migration exists and
passes adversarial migrated-instance tests.

### OAuth and other callbacks

OAuth flow state includes a high-entropy opaque value, is expiring, and is
single use. The current generic state also carries a parseable
username/generation routing prefix, while MCP uses those fields in its callback
path. The Gateway validates the exact active placement with `singleton`; the
target atomically consumes the complete state hash before exchanging the
authorization code. The routing prefix is not authority.

Kernel migration v23 adds nullable `oauth_flows.kernel_owner_uid`. Every new
flow records the human Kernel owner that admitted it. An authorization-code
callback first looks up the complete state hash, acquires lifecycle admission
for that exact owner, and only then atomically consumes the state. It retains
that operation through the bounded provider exchange and final credential
commit. Rows that were already in flight when v23 ran remain `NULL`; their
callbacks fail closed instead of guessing an owner from the run-as uid or the
routing prefix.

The same authorization rule applies to MCP OAuth and future callback types:
selection and authority remain separate. State mismatch, replay, expiry,
provider mismatch, or generation mismatch fails closed. Moving the routing hint
to an integrity-protected envelope is still target work.

### Adapters

An adapter service identity binds one deployed adapter. Adapter-specific
normalization stays in the adapter worker. Today the Master Control Program owns
the authoritative adapter account and identity-link tables. For every inbound
message, the scoped Gateway entrypoint sends `singleton` only exact, bounded
adapter/account/actor/frame and surface metadata. Message text, media, reply
context, and the full frame are excluded. The Master resolves the owner uid and
placement and, for an active user Kernel, issues a short-lived exact one-shot
authorization without receiving or awaiting the target payload. The Gateway
then sends the full frame directly to that user Kernel. The target consumes the
authorization at the Master, where current link generation and placement are
rechecked, then rechecks its local lifecycle before dispatch. Generic direct
`adapter.inbound` calls fail closed. A payload uid, username, peer label, or
reply address is untrusted.

Unknown DMs receive a link challenge generated from the bounded actor/surface
metadata, and unknown non-DM events receive a compact drop response; their text
and media do not enter `singleton`. Only an explicitly linked `legacy`
placement sends the full frame through the Master. Publishing bounded,
generation-bound link projections to adapters and user Kernels—and thereby
removing the remaining per-message Master metadata lookup—is target work.

Unknown actors can receive only a rate-limited linking flow. Link codes are
cryptographically random, short-lived, one-time, attempt-limited, and bound to
the adapter account and canonical account that created them. Outbound delivery
verifies the same account, username/uid, surface, and thread scope.

### Devices and credentials

A device record binds immutable owner canonical username, owner uid, device id,
and credential generation. Password and token verifiers remain in Master
Control Program state; user Kernels receive only successful identity/authority
results. Driver tokens bind owner, device, role, advertised
syscall subset, expiry, and generation. The driver connects to its owner's
`/ws/<username>` route and the user Kernel verifies that the token is bound to
that same account and device. A driver connection cannot change owner, claim
another device with the same token, or route a result outside the registered
request. Sharing a device requires an explicit group or device ACL; membership
in a generic human group is insufficient.

Password hashes, user and device token hashes, provider keys, OAuth/MCP
credentials, and personal encryption material live in Kernel-controlled state
or the narrowly scoped service that consumes them. Raw tokens are returned only
when issued and never copied into authority contexts, prompts, telemetry, or
another account's config. Ship-wide service credentials are an explicit
credential class and are not inherited by personal agents or packages.

### Files, repositories, and R2

The ship exposes one virtual filesystem with one Unix ownership namespace.
Paths such as `/home/alice` use the immutable canonical username for stable
human-facing addressing. The resulting objects remain owned by stable uid/gid
metadata; a path name never substitutes for a permission check.

R2 does not interpret or enforce Unix permissions. The `uid`, `gid`, `mode`,
and directory-marker fields stored in R2 custom metadata are inert bytes until
GSV code checks them. The security boundary is therefore `GsvFs`, its mount
backends, and any purpose-built internal storage API that enforces equivalent
Kernel-issued ownership. Direct use of an R2 binding with a caller-controlled
key bypasses filesystem permissions and is forbidden for user-reachable data.

Every object path must pass through an authorized storage boundary that:

- obtains uid and supplementary gids from trusted Kernel identity, never from
  the request or writable object metadata;
- checks execute permission on every explicit ancestor directory, read and
  execute for listing/search, and write and execute on a parent before child
  creation, rename, or deletion;
- applies owner, group, and other mode bits consistently to exact reads,
  ranges, streams, writes, appends, metadata changes, links, searches, copies,
  renames, and recursive operations;
- restricts `chmod` and `chown`, derives ownership on creation server-side, and
  preserves ownership on replacement unless an authorized ownership operation
  changes it;
- follows symlinks without escaping authorization checks or creating loops;
- authorizes every descendant before recursive deletion and produces no
  partial deletion when any descendant is denied;
- binds mutation to the object version or non-existence state that was checked,
  preventing a concurrent replacement from invalidating authorization; and
- treats missing, malformed, or ambiguous ownership metadata as denied once
  the legacy migration is complete.

Process media, archives, package artifacts, source overlays, and other internal
R2 key families are not exceptions. They use either the filesystem boundary or
a narrow typed store that authenticates the caller, derives its key, records
immutable owner metadata, and checks ownership on every read, list, and delete.
No user-controlled code receives a raw R2 binding.

Per-user physical R2 prefixes may still be useful for inventory, lifecycle
operations, backup, or defense in depth. A ship prefix is useful when multiple
ships deliberately share a bucket. Those prefixes are not the primary
cross-user security boundary and are not required to make Unix permissions
correct. They neither replace mode checks nor constrain root, Worker code, or a
direct R2 binding.

The app-placement verification key is a narrow internal exception to ordinary
filesystem content. The Master private key remains in `singleton` storage. Its
public SPKI record is published at the internal R2 key
`runtime/app-placement/verification-key-v1.json` with root ownership, mode
`0444`, and an internal storage marker. It is not mounted into the user
filesystem. The Gateway uses that public record to authenticate placement
before user-DO selection; it is not an account secret or a substitute for the
target's local checks.

Repositories follow the same logical model even though ripgit is not R2. A
repository has an immutable canonical account owner, owner uid, and explicit
visibility or sharing rules. Username-shaped Git paths are stable because the
canonical username cannot be renamed or reused; repository access still checks
the authenticated uid and sharing policy.

Git HTTP is a separate Gateway entrypoint and does not enter a user Kernel. The
Gateway sends the Master only the Basic credential and bounded admission
metadata: normalized repository owner/name, read-versus-write intent, and the
trusted login source used by the abuse limiter. The Master snapshots the
account's active or explicit-legacy placement, enters the same per-user
transition barrier used by lifecycle changes, runs bounded password-or-token
verification, then rechecks the exact username, uid, placement generation,
lifecycle, capabilities, and repository ACL. Credentials for unknown,
suspended, retired, or transitioning accounts still receive bounded verifier
work and the generic authentication result; they cannot be admitted as that
identity or reach private/write data-plane work. An explicitly public read may
still proceed anonymously under public repository policy.

A successful authorization is the Git request's admission point. Lifecycle
transitions stop new admission and drain credential checks already inside the
barrier; a request admitted before that linearization may complete. The Gateway
then forwards the original request body or response stream directly to RIPGIT,
which owns repository data-plane execution. Repository bytes never transit the
Master. Other repository commits, reads, imports, and deletion likewise remain
RIPGIT data-plane operations admitted through the owning runtime boundary.
The bounded `created_at`, `updated_at`, `description`, and `visibility` metadata
keys are Master-authoritative: the user Kernel forwards a typed mutation bound
to its active generation, and the Master reconstructs the actor, rechecks the
exact capability and repository ownership, persists only those normalized
keys, and refreshes safe projections. Non-root projections contain private
metadata only for repositories they may own and complete metadata for public
repositories; root receives all normalized repository metadata.

## Least privilege and sharing

Publicly admitted humans start with a reviewed non-root baseline. They receive
no root, wildcard, membership-administration, service, driver, or unrelated
resource authority. A generic `users` group may grant ordinary syscall
capabilities, but it must not make private files, processes, devices, package
state, or credentials group-readable by default.

Personal agents receive a smaller run-as capability set than their human owner.
Packages receive per-owner, per-entrypoint grants after review. Services and
drivers receive role- and target-bound tokens. Delegation can only narrow
authority.

Normal cross-user filesystem sharing uses explicit groups and Unix ownership or
ACL semantics. Other resources use first-class grants containing owner,
grantee, resource, operations, expiry, generation, and revocation state.
Absence, ambiguity, or stale state denies access. Before public registration,
sharing and root overrides must also become visible and attributable through the
release-gated security-audit ledger; that ledger is not implemented today.

## AI-assisted admission

> Target only: no public application endpoint, commissioning charter, admission
> agent, or admission grant exists in the current implementation. Registration
> remains closed.

Commissioning asks root to define two policy layers:

- a versioned free-text ship charter expressing human intent; and
- a deterministic envelope containing registration mode, member and pending
  limits, application size and turn limits, rate and cost budgets, retention,
  grant lifetime, allowed outcomes, and failure behavior.

Before an applicant submits, registration explains that the chosen canonical
username is their public identity in this ship, cannot be renamed, and remains
reserved after account deletion. A mutable display name is configured
separately.

Applicant text is hostile prompt input. The admission model is an untrusted
recommender, not an authorization principal. It receives only the pinned public
charter, bounded application text, and a fixed output schema. It has no tools,
credentials, root context, filesystem access, account-creation syscall, or
shared applicant conversation. Provider disclosure and retention rules are
shown before the applicant submits text.

Deterministic Kernel code validates the model response and chooses only among
fixed outcomes such as approve, deny, request more information, defer, or
manual review. It enforces hard limits regardless of the recommendation. Model
timeouts, malformed output, prompt injection, provider failure, and exhausted
budget fail closed or enter explicit manual review; they never default to
approval. Root may manually decide an application, but the action and policy
version are recorded only once the release-gated security-audit ledger exists.

Approval creates a random, short-lived, one-time admission grant. The Kernel
stores only its hash and binds it to application id, canonical username
reservation, charter version, fixed account tier, expiry, and grant generation.
Registration completion consumes that grant through one idempotent provisioning
state machine: the Master Control Program permanently reserves the canonical
username, allocates a never-reused uid and primary gid, records baseline groups,
and authorizes exactly `user:<username>` to initialize its matching account,
session, home, and runtime state. Credential verification state remains in the
Master Control Program. The account becomes active only after both
the global record and user Kernel agree on username, uid, lifecycle, and
provisioning generation. Passwords are supplied only during completion and
never enter the model request or application record. A dropped connection
cannot create two accounts, consume two ids, or activate half-provisioned state.

Policy changes append a new version. Every application remains pinned to its
recorded version or is invalidated by an explicit deterministic rule. The model
cannot choose capabilities, groups, uid, gid, Kernel object name, account tier,
rate limit, file mode, or resource grant.

## Abuse control, audit, and privacy

The current Master Control Program durably limits login verification work, and
link-challenge consumption has durable attempt limits. The broader abuse and
cost ledger described below is target work.

Before public registration, rate limits must run before expensive work and at
multiple dimensions: ship-wide, privacy-preserving source key, canonical
username, application, account, credential, device, adapter account, and model
budget. Login, registration, link-code creation and consumption, OAuth starts
and callbacks, app-session launch, and public webhooks must all have limits. A
future durable Master Control Program ledger is the authoritative membership
and inference-cost limit; edge rate limiting remains defense in depth. Closed
registration performs no admission inference.

Source addresses are not durable identity. Login abuse control retains only a
UTC-day HMAC-SHA-256 pseudonym derived with a stable per-ship random key; it
never persists the raw address. Source-target and source-work budgets prevent
one source from locking out another. Edge WAF limits remain required defense in
depth for distributed abuse and shared-network pressure. Limits must not let an
attacker permanently reserve a username with abandoned applications.

No security-audit event store or user/root audit-query surface exists today. The
target ledger uses an explicit metadata allowlist: timestamp, action,
authenticated actor canonical username, uid, role, applicable typed actor id,
target type and opaque id, policy/grant/session version or hash prefix, outcome,
reason code, latency, and trace id. It excludes passwords, raw bearer tokens,
OAuth codes, application statements, prompts, model messages, file contents,
tool arguments, and private paths. Each human must be able to inspect their own
security events. Root may inspect the ship-wide audit and underlying state; GSV
does not promise that audit records or member content are hidden from root.

Application text and model rationale are sensitive personal data with explicit
retention and deletion behavior. Telemetry aggregates outcomes and timings; it
does not become a second audit database or a cross-user content channel.

## Migration from legacy singleton state

Migration v16 inventories permanent account identities and records existing
login-capable accounts as `legacy`; it deliberately does not copy their runtime
state or provision their user Kernels. Those accounts continue through
`singleton` and `/ws`. Clean commissioning and human accounts created afterward
use active user Kernels. The remaining migration must move each legacy owner
without dual writers. Public registration remains disabled throughout.

The remaining migration plan is:

1. **Inventory immutable accounts and ownership.** Canonicalize every existing
   account name, reject normalization collisions, classify human, agent, and
   reserved system accounts, preserve every uid/gid, and mark every value
   permanently allocated. Inventory Kernel records, R2, ripgit, Process,
   AppRunner, OAuth, device, adapter, schedule, and route state; ambiguous
   ownership blocks the migration.
2. **Establish the Master Control Program directory.** Add versioned `singleton`
   schema for permanent canonical-name reservations, uid/gid allocation,
   account kind and lifecycle, group/capability state, credential and authority
   generations and provisioning records, plus the future admission policy,
   budgets, and audit events. Existing active usernames become immutable;
   deletion can retire but never release them.
3. **Make Kernel role and provisioning explicit.** A Kernel persists whether it
   is `master` or `user`, and a user Kernel persists its canonical username,
   uid, lifecycle, and provisioning generation. Only a Master Control
   Program-issued, name-bound grant may move an object from `unprovisioned` to
   `provisioning`. User Kernels never run singleton bootstrap logic or seed root
   state.
4. **Bind every runtime record.** Processes, AppRunners, sessions, OAuth flows,
   devices, adapter links, schedules, repositories, workspaces, media, and
   routes retain immutable canonical owner username and uid where needed, plus
   the owning user-Kernel route. Reject username/uid/Kernel mismatches. Revoke
   legacy sessions rather than translating caller-supplied identity.
   Authority-bearing AppRunner state hard-cuts to the owner-qualified
   `app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` and
   `app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` namespaces. The
   pre-owner-qualified `app-control-v2:` and `app-data:` objects and the older
   combined `app:` objects remain read-inaccessible; package SQL continuity
   remains gated on the explicit migration above.
5. **Move one owner at a time.** Keep exactly one writer for each dataset.
   Snapshot one human's user-owned state, append concurrent source mutations to
   an ordered log, catch up and verify counts/digests, briefly fence writes,
   atomically advance the writer epoch to `user:<username>`, and retain the old
   data read-only for a bounded rollback window. Never dual-write independently.
   Reissue sessions rather than copying them, expire in-flight OAuth state, and
   fence old schedule alarms before the new owner may wake.
6. **Cut over connection routing.** Reserve `/ws` for commissioning and route
   normal `/ws/<username>` connections to `user:<username>`. Existing live
   WebSockets reconnect; they are not transferred between objects. Only
   `active` accepts normal connections; unknown, unprovisioned, provisioning,
   suspended, retired, and invalid accounts retain one generic public
   authentication result. Process identity installation records the user Kernel
   so subsequent syscalls and signals do not traverse `singleton`.
7. **Migrate R2 authorization metadata.** Inventory every object and implicit
   prefix, classify its owner and purpose, create explicit directory markers,
   and write valid uid/gid/mode metadata. Quarantine or require root review for
   ambiguous objects. The R2 bucket remains shared; neither migration nor
   per-user Kernels turn prefixes into the permission boundary.
8. **Close storage bypasses.** Route all user-reachable R2 reads, ranges,
   streams, lists, writes, copies, and deletions through GsvFs or an equivalent
   typed authorization boundary. Re-key or wrap internal media, archive,
   package, and overlay stores where ownership cannot be proven. Audit code for
   direct binding access and keep only reviewed, non-user-addressable uses.
9. **Remove compatibility paths.** Delete trust in caller uid/username headers,
   metadata-less R2 objects, markerless authorization, singleton fallback for
   user-owned state, and implicit `singleton` process routes after clean and
   migrated deployments show no legacy use. Rebuild packages whose legacy loader
   records omitted public-file definitions, verify their full canonical hashes,
   conditionally replace those exact records with versioned artifacts, and then
   remove the narrow legacy artifact reader after only versioned records remain.

Durable Object SQLite changes use numbered migrations. External R2 and ripgit
migration is a durable state machine with versioned progress and idempotent
retries; it must not hold a Durable Object concurrency lock across external
I/O. Backup, rollback criteria, verification counts, quarantine behavior, and
irreversible cleanup are documented before cutover.

## Adversarial validation

Validation includes clean-instance and migrated-instance tests with root and at
least two non-root humans in separate user Kernels inside the same ship.
Required attacks include:

- raw Unicode/case/whitespace/percent-encoding normalization collisions,
  attempted rename or reuse, enumeration, uid/gid reuse, direct addressing of
  unprovisioned Kernel names, and concurrent registration completion;
- forged Kernel names, provisioning grants, writer epochs, lifecycle state, and
  username/uid pairs; deletion or storage reset followed by attempted
  reprovisioning of a retired username;
- forged, stale, oversized, or mismatched app-placement certificates and local
  route HMACs, proving rejection occurs before selecting a user Durable Object;
- projection revision rollback, same-revision digest mismatch, package-fence
  crashes at every prepare/commit/refresh/clear point, and AppRunner registry or
  drain acknowledgement mismatch;
- forged uid/gid/username headers and object metadata; session tampering,
  audience confusion, replay, expiry, revocation, generation changes, and late
  responses;
- cross-user process list/history/control, IPC, HIL, signals, config, package
  RPC and SQL, app sessions, OAuth, schedules, media, adapters, and devices;
- filesystem traversal through direct paths, parent directories, symlinks,
  ranges, streams, search, copy, rename, recursive delete, markerless prefixes,
  malformed metadata, group changes, and concurrent object replacement;
- attempts to reach internal R2 keys or use any direct R2-binding call from a
  user-controlled path, plus static inventory proving every key family has an
  authorized owner boundary;
- ripgit owner substitution/reuse, repository visibility mistakes, workspace
  owner confusion, and source-overlay collisions;
- OAuth state swapping and replay, callback/provider mismatch, app cookie
  theft, adapter uid spoofing, link-code guessing/replay, and service-token
  misuse;
- admission prompt injection, malformed model output, provider timeout and
  rate limit, budget exhaustion, policy replacement, grant replay, and
  provisioning failure after grant consumption; and
- audit and telemetry inspection proving prohibited credentials and content
  are absent.

Positive tests prove that explicit owner and group permissions work and that
root can intentionally access and repair every user's resources. Failure
injection covers Durable Object eviction, disconnects, duplicate delivery,
R2/ripgit failure, model failure, and retries at every provisioning and
migration transition. Tests assert denial and cleanup: routes, bodies, pending
grants, reservations, credentials, and temporary state reach one terminal
outcome. Load tests prove that one hot user affects its own Kernel but does not
starve another user or the Master Control Program. Model token events, device
bodies, app bodies, repository packfiles, and adapter content must stay off
`singleton`; any remaining per-request Master checks must have bounded metadata
and work that does not scale with those payloads.

## Public-registration release gates

Registration mode remains `closed` by default, including after an upgrade. No
public application or account-creation endpoint is enabled in production until
all of these gates pass:

1. **Identity namespace:** immutable, permanently reserved canonical usernames;
   unique, never-reused uids and gids; explicit account kind and lifecycle;
   mutable display names; suspension, terminal retirement, and generic
   authentication errors.
2. **Kernel provisioning and routing:** `/ws` is commissioning-only;
   `/ws/<username>` routes to exactly `user:<username>`; only a name-bound Master
   Control Program grant can provision it; unknown and non-active objects fail
   closed; process routes bind the owning user Kernel and its exact generation.
3. **Master authority and isolation:** `singleton` remains the only writer for
   global names, ids, groups, capabilities, admission, and cross-user grants,
   while user-owned payload and execution data planes stay in their owning
   components. Remaining Master credential, placement, link, package, and
   repository checks are bounded metadata operations. No caller-supplied uid,
   gid, username, Kernel name, or object metadata selects authority.
4. **Filesystem enforcement:** every user-reachable R2 path goes through an
   authorized boundary; modes, ancestors, symlinks, streaming, recursive
   operations, and conditional mutations pass cross-user tests; legacy missing
   metadata and markerless prefixes have migrated to fail closed.
5. **Resource isolation and least privilege:** Process state, package state,
   ripgit, media, devices, adapters, OAuth, schedules, credentials, and app
   sessions enforce immutable ownership; no public account receives root,
   wildcard, ship administration, or unintended group sharing.
6. **Admission safety:** versioned root charter and deterministic envelope,
   strict model schema, tool-less inference, single-use grants, idempotent
   provisioning, manual failure policy, and password/model separation are
   complete.
7. **Abuse resistance:** login, application, completion, linking, callbacks,
   public apps, and inference have durable rate and cost limits tested under
   concurrency and provider failure.
8. **Audit and trust disclosure:** identity and root actions are attributable;
   redaction, retention, deletion, provider disclosure, incident procedures,
   the permanent public-username commitment, and the ship-root trust
   relationship are documented and verified.
9. **Migration and operations:** existing deployments migrate without dual
   writers or permissive metadata fallback; backup, rollback, quarantine,
   revocation, account recovery, and cleanup have production runbooks.
10. **Adversarial E2E:** the validation matrix above passes on a clean ship and a
   representative upgraded ship, including root, two mutually untrusted
   humans in separate user Kernels, disconnect, replay, race, hot-shard
   isolation, and partial-failure cases.

Physical per-user R2 prefixes are not a release gate. Complete authorization is.
Model quality is not a substitute for any gate. Until the deterministic
multiuser boundary is complete, GSV may experiment with charter authoring and
root-reviewed applications, but it must not expose autonomous public account
creation.

## See also

- [Security Model](./security-model.md)
- [Architecture Overview](./index.md)
- [The Agent Loop](./agent-loop.md)
- [The Adapter Model](./adapter-model.md)
- [Process IPC and Scheduler](./process-ipc-and-scheduler.md)
