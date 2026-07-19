# Multiuser Security Architecture

> Status: target architecture and release contract. The current implementation
> already routes one deployment to a Kernel Durable Object named `singleton`,
> but it does not yet satisfy every multiuser invariant below. Public
> registration remains closed until the release gates in this document pass.

GSV multiuser support turns one personal computer into a small, internet-facing
ship with several mutually untrusted humans. The ship is intentionally one
Linux-like security domain: one Kernel, one global identity namespace, and one
root user. This is a security-boundary change, not only an account-creation
feature.

The singleton is therefore the ship's shared OS Kernel, not a singleton human.
Every human receives a distinct account, immutable principal, uid, primary gid,
home, credentials, processes, agents, packages, devices, and external links
inside that Kernel. The Kernel applies capabilities and resource ownership
centrally. A logged-in non-root human must not gain ambient access to another
human's resources.

Ship root is intentionally omnipotent. Root may inspect, modify, delegate, or
delete any member's files, credentials, connected devices, and runtime state.
GSV must make that trust relationship clear during registration; it does not
claim to isolate members from the person who owns root or from the deployment
operator.

This document defines the target boundary, threat model, migration sequence,
and release gates. The existing [Security Model](./security-model.md) remains
the description of current authentication, capabilities, and resource checks.

## Security goals

The multiuser design must preserve these properties:

- One ship Kernel Durable Object is the authoritative control plane for every
  human and system identity in that ship. It is one coordination atom per ship,
  not one global object shared by unrelated deployments.
- Every security principal has an immutable `principalId`. Every uid and gid is
  unique within the ship, permanently allocated, and never reused. Usernames
  are mutable login and display aliases, never durable ownership keys.
- Every request acquires its principal, uid, gids, and capabilities from
  authenticated Kernel state. Client-supplied usernames, uids, gids, headers,
  paths, metadata, or object ids do not confer authority.
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
budget, and security audit records.

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

Durable Objects follow the actual coordination atoms. The ship Kernel owns the
global identity and authorization namespace. Process and AppRunner objects own
durable execution state, but they do not become independent security
authorities.

| Component | Authoritative state | Must not own |
| --- | --- | --- |
| Ship Kernel | Ship id; immutable principals; global uid/gid allocation; username aliases and tombstones; passwords and tokens; groups and capabilities; membership and admission policy; resource ownership; devices; packages; process registry; routes; grants; rate budgets; security audit metadata | Heavy computation, untrusted model decisions, UI rendering, adapter-specific identity rules, or device-native work |
| Process DO | One Kernel-issued owner and run-as identity; history; queue; pending tools; approvals; process-local media references | Account creation, uid/gid allocation, group membership, capability expansion, or authority derived from a frame |
| AppRunner DO | One Kernel-issued owner identity and package runtime; sessions; package SQLite; explicitly granted calls | Another user's session or storage, membership, root authority, or grants broader than the invoking session |
| Authorized filesystem boundary | Path resolution; mount routing; caller identity; Unix mode and ownership checks; safe R2 operations | Trust in caller-supplied uid/gid/mode or the assumption that R2 enforces custom metadata |
| Adapter or device | Platform or machine transport state and only narrowly advertised operations | Authority derived from a payload username/uid or a broad ship credential |

The one Kernel is an intentional singleton for one ship. Membership,
username uniqueness, uid/gid allocation, authentication, group membership, and
resource ownership require one strongly ordered authority. Model inference,
package execution, process loops, file bytes, repository work, and
platform-native operations remain in their owning services. The Kernel must not
hold a transaction or initialization lock across inference, R2, ripgit, device,
adapter, or other external I/O.

The current deployment boundary is one ship: one Gateway deployment, its
Kernel named `singleton`, and its bound storage stack. A request cannot select
another ship. Future multi-ship hosting would need a trusted deployment or
allowlisted-host mapping plus explicit ship scope in every Kernel, AppRunner,
R2, service, and callback locator; it must never use a request body or an
unverified `Host` value. Separate ships never merge uid/gid namespaces.

Ship administration may be delegated through narrow capabilities, but uid `0`
is different: root is the superuser and bypasses normal ownership and mode
checks. Product surfaces should avoid casual impersonation and record root
operations, but they cannot truthfully promise technical privacy from root.

## Principal identity, uid/gid, and username aliases

Every security principal receives a cryptographically random, immutable
`principalId`. Human, agent, package, service, adapter, and device records use
that identifier for durable ownership and audit relationships. Principal ids
are never changed or reused, including after account deletion.

The Kernel also allocates each account a stable numeric uid and each group a
stable numeric gid. The namespace is global within the ship:

- uid `0` and gid `0` are permanently root;
- system identities and groups occupy reserved ranges;
- every human and agent uid is unique and never reused;
- every private or shared gid is unique and never reused; and
- deleted identities leave durable tombstones for principal id, uid, gid, and
  formerly valid login aliases.

Numeric uid/gid values are the native filesystem ownership keys because all
filesystem access belongs to the same ship Kernel. The immutable principal id
is the durable identity, relationship, routing, and audit key. Records that
store a uid also store or join to its principal and must reject a mismatch.
Neither value is accepted from an untrusted client when establishing identity.

A normalized username is a unique, mutable alias in the Kernel directory.
Username normalization is versioned and performed once at the Kernel. Creation
and rename atomically reserve the canonical alias. Removed or renamed aliases
remain tombstoned for a configured period so an old link, token, Git remote, or
callback cannot silently identify a new human. Renaming a user changes login
and display routing; it does not change principal id, uid, gid, file ownership,
process ownership, or audit history.

Login follows this order:

1. The Gateway forwards only Cloudflare's edge-authored source address. The
   Kernel immediately replaces it with a UTC-day HMAC pseudonym and reserves
   source-target and source-work budgets before expensive work. Edge WAF limits
   remain defense in depth for distributed abuse.
2. The Kernel normalizes the username and resolves it to an active principal,
   while preserving one generic external failure shape for missing, suspended,
   and invalid accounts.
3. The Kernel verifies the password or token against that principal's stored
   credential and derives uid, supplementary gids, capabilities, and identity
   generation from authoritative state.
4. Successful authentication creates a session bound to ship, principal, uid,
   connection, role, audience, expiry, and generation.

Suspension, credential reset, destructive group change, or account removal
increments the relevant generation and closes existing sessions. A username is
never sufficient to recover or retarget an authenticated session.

## Kernel-issued authority context

Whenever work crosses the Gateway, Kernel, Process, AppRunner, adapter, or
device boundary, the receiver needs an unforgeable Kernel-issued authority
context. It may be a signed, short-lived ticket or an opaque reference to
Kernel state; the representation is secondary to the invariants.

An authority context binds at least:

- ship id, immutable principal id, uid, supplementary gids, and actor/run-as
  identity;
- issuer and exact audience role and object id;
- connection or session id and request or route purpose;
- allowed syscall or capability subset and bounded resource identifiers;
- issue time, expiry, nonce, credential generation, and route generation; and
- parent context or explicit delegation record when authority was narrowed.

It contains no password, provider key, OAuth token, private prompt, or
unrestricted return address. The receiver verifies integrity, audience, expiry,
generation, and scope before parsing a caller-controlled resource id. Critical
mutations recheck current Kernel state. Delegation can narrow authority but can
never change principal, choose uid/gid, add a group, or expand capabilities.

The Kernel issues authority for Processes, AppRunners, devices, app sessions,
callbacks, and adapters. Responses follow the route registered for the request,
not a return route supplied in an untrusted frame. A globally meaningful PID,
session id, device id, callback state, or `x-gsv-*` header may select a lookup
candidate but does not authorize dispatch by itself.

## Resource authorization

Every syscall first requires the relevant capability. Object-owning handlers
then enforce uid ownership, group/ACL membership, or another explicit resource
grant. A broad capability such as `fs.*` permits use of that syscall family; it
does not make every file accessible. Possession of `*` is reserved for gid `0`,
and object-level superuser checks use uid `0`.

### Processes and conversations

A Process stores immutable ship, owner principal, owner uid, run-as principal,
run-as uid/gids, parent, and creation-generation metadata. Personal and package
agents remain subordinate to a human owner even when they run under their own
uid. Process creation and every delivered frame use a Kernel-issued identity;
the Process cannot accept an owner or run-as uid from message content.

Process listing, history, control, IPC, signals, human-in-the-loop replies,
archives, and media verify the caller against the stored owner and current
Kernel state. Same-owner IPC is the default. Cross-user IPC requires an
explicit grant and never shares conversation history implicitly. Late results
from a cancelled or superseded run cannot mutate current process state.

### Packages, AppRunner, and public app routes

AppRunner identity includes immutable owner principal and package id so runtime
state and sessions cannot collide across humans. App sessions and cookies bind
principal, uid, package, entrypoint, session, client, capability subset, expiry,
and generation. The Gateway strips caller-authored identity headers and adds
trusted runtime context only after the Kernel resolves the session.

Package SQL, app signals, daemon state, browser RPC, and public webhook routes
remain in that owner scope. A public route has an explicit owner and entrypoint
record; the Gateway does not search for a matching user or trust a username in
the route. Package approval grants only the requested entrypoint capabilities
for that owner and cannot inherit root or wildcard authority.

### OAuth and other callbacks

OAuth `state` is high entropy, opaque, expiring, and single use. The Kernel
stores only its hash with the owning principal, flow verifier, provider,
generation, and minimum routing metadata. A callback resolves that state to
exactly one account before consuming the authorization code. Principal ids and
usernames need not appear in callback URLs.

The same rule applies to MCP OAuth, package callbacks, adapter webhooks, and
other unauthenticated return paths: opaque state chooses an authoritative
Kernel record; the callback payload never chooses a uid. State mismatch,
replay, expiry, provider mismatch, or generation mismatch fails closed.

### Adapters

An adapter service identity binds one deployed adapter and account. Each
adapter account is owned by one principal or explicitly declared as a shared
ship service. The Kernel resolves adapter, account, and normalized external
actor to a local principal before it delivers a message. A payload uid,
username, peer label, or reply address is untrusted.

Unknown actors can receive only a rate-limited linking flow. Link codes are
cryptographically random, short-lived, one-time, attempt-limited, and bound to
the adapter account and principal that created them. Outbound delivery verifies
the same account, principal, surface, and thread scope.

### Devices and credentials

A device record binds immutable owner principal, owner uid, device id, and
credential generation. Driver tokens bind owner, device, role, advertised
syscall subset, expiry, and generation. A driver connection cannot change
owner, claim another device with the same token, or route a result outside the
registered request. Sharing a device requires an explicit group or device ACL;
membership in a generic human group is insufficient.

Password hashes, user and device token hashes, provider keys, OAuth/MCP
credentials, and personal encryption material live in Kernel-controlled state
or the narrowly scoped service that consumes them. Raw tokens are returned only
when issued and never copied into authority contexts, prompts, telemetry, or
another principal's config. Ship-wide service credentials are an explicit
credential class and are not inherited by personal agents or packages.

### Files, repositories, and R2

The ship exposes one virtual filesystem with one Unix ownership namespace.
Paths such as `/home/alice` are human-facing names; resolving the account home
uses Kernel directory state, and the resulting objects remain owned by stable
uid/gid values across username changes.

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

Repositories follow the same logical model even though ripgit is not R2. A
repository has an immutable principal owner and explicit visibility or sharing
rules. Username-shaped Git paths resolve through the Kernel directory to that
owner; renaming or reusing an alias cannot transfer a repository.

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
Sharing is visible and auditable. Absence, ambiguity, or stale state denies
access. Root can override these controls by design, and root operations remain
attributable in the security audit.

## AI-assisted admission

Commissioning asks root to define two policy layers:

- a versioned free-text ship charter expressing human intent; and
- a deterministic envelope containing registration mode, member and pending
  limits, application size and turn limits, rate and cost budgets, retention,
  grant lifetime, allowed outcomes, and failure behavior.

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
version are audited.

Approval creates a random, short-lived, one-time admission grant. The Kernel
stores only its hash and binds it to application id, canonical username
reservation, charter version, fixed account tier, expiry, and grant generation.
Registration completion atomically consumes that grant and allocates a new
principal id, never-reused uid, primary gid, home ownership, and baseline
groups. Passwords are supplied only during completion and never enter the model
request or application record. Retries use an idempotent provisioning state
machine; a dropped connection cannot create two accounts or consume two ids.

Policy changes append a new version. Every application remains pinned to its
recorded version or is invalidated by an explicit deterministic rule. The model
cannot choose capabilities, groups, uid, gid, principal id, account tier, rate
limit, file mode, or resource grant.

## Abuse control, audit, and privacy

Rate limits run before expensive work and at multiple dimensions: ship-wide,
privacy-preserving source key, canonical username, application, principal,
credential, device, adapter account, and model budget. Login, registration,
link-code creation and consumption, OAuth starts and callbacks, app-session
launch, and public webhooks all have limits. A durable Kernel ledger is the
authoritative membership and inference-cost limit; edge rate limiting is useful
defense in depth. Closed registration performs no admission inference.

Source addresses are not durable identity. Login abuse control retains only a
UTC-day HMAC-SHA-256 pseudonym derived with a stable per-ship random key; it
never persists the raw address. Source-target and source-work budgets prevent
one source from locking out another. Edge WAF limits remain required defense in
depth for distributed abuse and shared-network pressure. Limits must not let an
attacker permanently reserve a username with abandoned applications.

Security audit events use an explicit metadata allowlist: timestamp, action,
authenticated actor principal and uid, target type and opaque id,
policy/grant/session version or hash prefix, outcome, reason code, latency, and
trace id. They exclude passwords, raw bearer tokens, OAuth codes, application
statements, prompts, model messages, file contents, tool arguments, and private
paths. Each human can inspect their own security events. Root can inspect the
ship-wide audit and underlying state; GSV does not promise that audit records
or member content are hidden from root.

Application text and model rationale are sensitive personal data with explicit
retention and deletion behavior. Telemetry aggregates outcomes and timings; it
does not become a second audit database or a cross-user content channel.

## Migration from the current singleton

The current Gateway already routes WebSocket, OAuth, Git, package app, and
other control paths to a Kernel named `singleton`. The migration keeps that
per-ship Kernel and strengthens it into the authoritative shared OS Kernel. It
does not extract one Kernel per human. Public registration remains disabled
throughout migration.

1. **Inventory and identify.** Assign every existing human and agent an
   immutable principal id. Preserve every existing uid/gid, mark it permanently
   allocated, and add durable tombstones. Inventory Kernel records, R2, ripgit,
   Process, AppRunner, OAuth, device, adapter, schedule, and route state;
   ambiguous ownership blocks the migration.
2. **Establish the global directory.** Add versioned Kernel schema for
   principals, uid/gid allocation, username aliases and tombstones, membership
   status, credential and route generations, admission policy, reservations,
   and audit events. Provisioning allocates all identity state atomically in
   Kernel SQLite before external home setup proceeds idempotently.
3. **Bind every runtime record.** Add immutable owner principal and uid fields
   to processes, packages, AppRunners, sessions, OAuth flows, devices, adapter
   links, schedules, repositories, workspaces, media, and routes. Reject
   mismatches between legacy uid and principal. Revoke legacy sessions rather
   than translating caller-supplied identity.
4. **Migrate R2 authorization metadata.** Inventory every object and implicit
   prefix, classify its owner and purpose, create explicit directory markers,
   and write valid uid/gid/mode metadata. Quarantine or require root review for
   ambiguous objects. Remove compatibility defaults and make missing or
   malformed metadata fail closed only after the inventory is clean.
5. **Close storage bypasses.** Route all user-reachable R2 reads, ranges,
   streams, lists, writes, copies, and deletions through GsvFs or an equivalent
   typed authorization boundary. Re-key or wrap internal media, archive,
   package, and overlay stores where ownership cannot be proven. Audit code for
   direct binding access and keep only reviewed, non-user-addressable uses.
6. **Decouple aliases from storage.** Give ripgit repositories, account homes,
   workspaces, callbacks, and public routes immutable owner records and stable
   backend locators. Username-based paths remain aliases and never transfer
   ownership after rename or tombstone expiry.
7. **Remove compatibility paths.** Delete trust in caller uid/username headers,
   metadata-less R2 objects, markerless authorization, and username-keyed
   ownership after clean and migrated deployments show no legacy use. Rebuild
   packages whose legacy loader records omitted public-file definitions, verify
   their full canonical hashes, conditionally replace those exact records with
   versioned artifacts, and then remove the narrow legacy artifact reader after
   only versioned records remain.

Durable Object SQLite changes use numbered migrations. External R2 and ripgit
migration is a durable state machine with versioned progress and idempotent
retries; it must not hold a Durable Object concurrency lock across external
I/O. Backup, rollback criteria, verification counts, quarantine behavior, and
irreversible cleanup are documented before cutover.

## Adversarial validation

Validation includes clean-instance and migrated-instance tests with root and at
least two non-root humans in the same Kernel. Required attacks include:

- username normalization collisions, rename/reuse, enumeration, uid/gid reuse,
  and concurrent registration completion;
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
- ripgit alias rename/reuse, repository visibility mistakes, workspace owner
  confusion, and source-overlay collisions;
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
outcome.

## Public-registration release gates

Registration mode remains `closed` by default, including after an upgrade. No
public application or account-creation endpoint is enabled in production until
all of these gates pass:

1. **Identity namespace:** immutable principal ids; unique, never-reused uids
   and gids; atomic username aliases and tombstones; suspension, deletion, and
   generic authentication errors.
2. **Kernel authority:** every login, Process, AppRunner, device, adapter,
   OAuth, app, Git, and callback route derives identity from the one ship
   Kernel; no caller-supplied uid, gid, username, or object metadata selects
   authority.
3. **Filesystem enforcement:** every user-reachable R2 path goes through an
   authorized boundary; modes, ancestors, symlinks, streaming, recursive
   operations, and conditional mutations pass cross-user tests; legacy missing
   metadata and markerless prefixes have migrated to fail closed.
4. **Resource isolation and least privilege:** Process state, package state,
   ripgit, media, devices, adapters, OAuth, schedules, credentials, and app
   sessions enforce immutable ownership; no public account receives root,
   wildcard, ship administration, or unintended group sharing.
5. **Admission safety:** versioned root charter and deterministic envelope,
   strict model schema, tool-less inference, single-use grants, idempotent
   provisioning, manual failure policy, and password/model separation are
   complete.
6. **Abuse resistance:** login, application, completion, linking, callbacks,
   public apps, and inference have durable rate and cost limits tested under
   concurrency and provider failure.
7. **Audit and trust disclosure:** identity and root actions are attributable;
   redaction, retention, deletion, provider disclosure, incident procedures,
   and the ship-root trust relationship are documented and verified.
8. **Migration and operations:** existing deployments migrate without dual
   writers or permissive metadata fallback; backup, rollback, quarantine,
   revocation, account recovery, and cleanup have production runbooks.
9. **Adversarial E2E:** the validation matrix above passes on a clean ship and a
   representative upgraded ship, including root, two mutually untrusted
   humans, disconnect, replay, race, and partial-failure cases.

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
