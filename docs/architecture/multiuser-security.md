# Multiuser Security Architecture

> Status: username-sharded runtime is implemented for commissioning and
> privileged account creation. The Master remains authoritative for the ship
> namespace; user Kernels keep no durable authority replicas. Existing-state
> cutover validation, security audit and cost ledgers, lifecycle administration,
> cross-shard root tooling, and public admission remain release work. Public
> registration is closed.

GSV multiuser support turns one user-owned deployment into a small,
internet-facing ship for several mutually untrusted humans. The ship remains
one Linux-like security domain: one global account and Unix ownership namespace,
one root user, one Master Control Program, and one runtime Kernel per
login-capable human.

The Durable Object named `singleton` is the ship's Master Control Program. It is
not a singleton human runtime. Each login-capable human is placed at a Kernel
named `user:<canonical-username>` and reaches `active` before normal work is
admitted. That user Kernel owns the human's connections, devices, process
registry, routes, schedules, and OAuth/MCP coordination. The Master owns global
identity and authorization state and answers narrow RPCs from those user
Kernels.

This split removes ordinary user sessions and process coordination from the
global object's active routing and ownership without deleting its dormant old
rows or creating a second authority store. Adapter messaging is the explicit
current exception: it traverses the Master in both directions so the Master can
apply the live external-identity link. Model streams, filesystem bodies, device
traffic, app bodies, and repository data do not use the Master as their data
plane.

Ship root is intentionally omnipotent. Unix permissions isolate one non-root
member from another; they do not protect a member from uid `0`, the deployment
operator, replacement Worker code, or code with a raw storage binding. GSV must
make that trust relationship clear before accepting public members.

## Security goals

The design preserves these properties:

- `singleton` is the only authority for canonical account names, uid/gid
  allocation, credentials, groups, capabilities, system configuration,
  packages, repository metadata, adapter accounts and links, user-Kernel
  placement, commissioning, and future admission policy.
- Every login-capable human has one provisioned user Kernel named directly from
  their immutable canonical username. One hot user's normal runtime load does
  not load another user's Kernel.
- User Kernels hold no durable copy of Master-owned account, capability,
  configuration, package, repository, or link state. They resolve the current
  answer through typed Master RPCs or master-owned syscalls.
- Canonical usernames are lower-case ASCII public identities. They are unique
  within the ship, immutable, permanently reserved, and never reused. Uids and
  gids are likewise never reused.
- Every request obtains username, uid, gids, capabilities, role, and typed
  resource identities from authenticated runtime state. Caller-supplied
  usernames, uids, gids, headers, paths, metadata, and object names do not grant
  authority.
- Filesystem authorization is the cross-user file boundary. Owner, group,
  other, directory traversal, and root semantics apply to every native
  filesystem operation even though the physical R2 bucket is shared.
- Cross-user access is denied unless Unix permissions, an explicit group or
  ACL, or another bounded resource grant allows it.
- Model output, package output, adapter payloads, and device responses are
  untrusted data. None can mint identity, capability, membership, filesystem
  metadata, or route authority.
- Public work has deterministic abuse and cost ceilings before password
  hashing, model inference, account creation, or other expensive operations.

## Threat model

Protected assets include password hashes, bearer tokens, provider and OAuth
credentials, private files and repositories, process history and media,
package state, device access, adapter links, membership policy, route state,
inference budget, and future security-audit records.

The design assumes attacks from:

- unauthenticated clients probing usernames, passwords, callbacks, app routes,
  linking, registration, and adapter ingress;
- authenticated non-root members trying to cross uid, gid, process, package,
  repository, device, adapter, or filesystem boundaries;
- prompt injection in applications, messages, files, pages, tool results,
  adapter events, device descriptions, or model responses;
- compromised Processes, packages, AppRunners, browser apps, devices, adapters,
  or external providers;
- stolen, replayed, confused-audience, or expired sessions, tokens, OAuth state,
  link codes, and registration grants;
- allocation, provisioning, permission, callback, revocation, and storage
  replacement races; and
- accidental raw R2 access that bypasses GSV filesystem authorization.

Denial of service is in scope at the product boundary. Public callers must not
have unbounded access to Durable Object work, password verification, inference,
storage, or provisioning. Complete protection from volumetric attacks outside
the deployed Cloudflare controls is not a GSV runtime guarantee.

Root acting deliberately is not an attacker in this model. A ship that must
hide member data from its administrator needs a different cryptographic design,
such as member-held encryption keys.

## Ownership and isolation boundaries

Durable Objects follow coordination atoms. The Master owns the global namespace;
each user Kernel owns one human's runtime coordination; Process and AppRunner
objects own durable execution state but do not become independent identity
authorities.

| Component | Authoritative state | Must not own |
| --- | --- | --- |
| Master Control Program (`singleton`) | Permanent account-name reservations; uid/gid allocation; account state; credential verifiers; login and link throttles; groups and capabilities; system configuration; packages; normalized repository metadata; adapter accounts and identity links; commissioning; user-Kernel placement; future admission, budgets, and audit | Ordinary user WebSockets; per-user process routing; model streams; filesystem or device bodies; app execution; repository data-plane work; adapter-specific protocol behavior; untrusted model recommendations treated as authority |
| User Kernel (`user:<username>`) | Matching username/uid provisioning marker; this human's authenticated connections, local sessions, devices, process registry, routes, notifications, schedules, OAuth/MCP state, and local app-session HMAC key | Any durable replica of Master authority; credential verification; global allocation; another human's private runtime; file bytes; Process history; package execution state; authority inferred from its requested object name |
| Process DO | One Kernel-installed owner and run-as identity; conversation history; queue; pending tools; approvals; process-scoped media references | Account creation; global authorization state; capability expansion; authority derived from a frame or PID |
| AppRunner (`app:<actorUid>:<packageId>`) | Package runtime, daemon schedules, live sockets, and package SQLite for one ship-global actor uid and package | Account, package, or app-session authority; another actor's state; authority inferred from its deterministic name |
| GsvFs or an equivalent typed store | Path resolution; mount routing; caller identity; Unix ownership and mode checks; authorized R2 operations | Trust in caller-supplied uid/gid/mode or an assumption that R2 enforces custom metadata |
| Adapter or device | Platform or machine transport state and narrowly advertised operations | Authority derived from a payload username/uid or a broad ship credential |

No Kernel may hold a Durable Object concurrency lock across inference, R2,
RIPGIT, device, adapter, or other external I/O.

The current deployment boundary is one ship: one Gateway deployment, one Master
named `singleton`, its `user:<username>` Kernels, and its bound storage stack.
Future multi-ship hosting needs explicit trusted ship scope everywhere. It must
not derive ship identity from an unverified `Host` header or request body.

### Master-authoritative reads

A user Kernel does not mirror `/etc/passwd`, capabilities, system configuration,
packages, repository metadata, or adapter links into its own SQLite. It asks the
Master for the smallest answer required by the operation. Public examples are
`account.get`, `sys.cap.list`, `sys.config.get`, `pkg.list`, and `repo.list`;
internal runtime code uses equally narrow typed RPCs for operations such as an
authorized auth-file view or package record lookup.

The Master validates that an internal request comes from gateway-controlled code
for the named `user:<canonical-username>` object, that its placement matches the
claimed uid, and that the requested run-as account is owned by or delegable from
that human. It reconstructs the returned identity and applies field-level
redaction. A source Kernel name is an assertion to validate, not a bearer token.

Master-owned mutation syscalls remain serialized at the Master. User-owned
runtime mutations remain local to the user Kernel. Every authority read is live
and narrowly scoped, with one writer for each dataset.

## Canonical identity, provisioning, and login

Every account receives one canonical username. It is the account's public,
durable identity; for a login-capable human it is also the user-Kernel routing
key. A mutable human-facing name belongs in GECOS or another explicit display
field and never changes identity or routing.

Canonical usernames use the shared lower-case ASCII account grammar. Creation
atomically reserves the canonical value. Uid `0` and gid `0` remain root;
system ranges remain reserved; every human, agent, and group id is unique and
never reused. Device ids, token ids, PIDs, adapter account ids, and other typed
ids remain distinct from usernames and uids.

Only login-capable humans receive user Kernels. Root logs in through
`user:root`. Agent and system accounts stay in the global Unix namespace but do
not receive a Kernel merely because they have a username. There is no second
principal id or mutable login alias in front of this mapping.

The Master placement registry and target marker use two persisted states:
`provisioning` and `active`. No marker means unprovisioned. Arbitrary Durable
Object names exist on demand, so merely addressing `user:alice` may instantiate
an object; it must not initialize, authenticate, or serve normal traffic unless
the Master has reserved the exact username/uid pair and activation has completed.
Only `active` accepts normal work.

Normal login follows this order:

1. The Gateway decodes and canonicalizes `/ws/<username>`, strips internal
   headers supplied by the caller, and asks the Master for the placement.
2. An unknown placement returns 404. For a known `provisioning` placement, the
   Master idempotently completes provisioning; only the resulting `active`
   placement selects exactly `user:<canonical-username>`. Failed provisioning
   returns 404 before WebSocket upgrade.
3. The target verifies its durable username/uid marker and active state.
4. The user Kernel asks the Master to authenticate. The Master applies durable
   login limits before password or token verification and rechecks the exact
   placement and account.
5. The Master returns the authenticated uid, role, gids, and capabilities, not
   credential material. The user Kernel binds that result to local connection
   state.

`/ws` is commissioning-only. It never acts as a fallback route for a normal
account.

## Runtime authority

A route locator selects where authority can be checked; it is never authority
itself. The receiver must validate its local record and, where the decision is
Master-owned, obtain a current Master decision before performing the operation.
Responses follow a route registered by the runtime, not a return address in an
untrusted payload.

Delegation may narrow the actor or capability set. It may not change the owning
human, choose a uid/gid, add a group, or expand capabilities. A deterministic DO
name, PID, session id, callback path, device id, or `x-gsv-*` header is only a
lookup candidate.

Every syscall first requires the relevant capability. The owning handler then
checks uid ownership, group/ACL membership, or a typed resource grant. A broad
capability such as `fs.*` permits use of that syscall family; it does not make
every file accessible. The wildcard capability and object-level superuser
bypass remain reserved for root.

### Processes and conversations

A Process stores its owning Kernel, human owner uid, and run-as account. The
user Kernel registry binds the PID to that identity. Personal and package agents
remain subordinate to their human owner even when they run under distinct uids.
Process listing, history, control, IPC, signals, human-in-the-loop replies,
archives, and media all verify the caller against the stored record.

Same-owner IPC is the default. Cross-user IPC requires an explicit Master-owned
grant and never exposes conversation history implicitly. Cancellation and
supersession remain Process lifecycle operations; late output from a cancelled
or stale run cannot mutate the active run.

### Packages, AppRunner, and public app routes

One deterministic AppRunner named `app:<actorUid>:<packageId>` owns the
runtime and SQLite for that ship-global actor uid and package. The name prevents
accidental collisions; it does not authorize a request.

Before package traffic is admitted, the active user Kernel asks the Master to
validate the current run-as account, enabled/reviewed package, artifact hash,
entrypoint, and requested capability. AppRunner calls back through the same user
Kernel with an exact app frame. AppRunner does not read Master stores or infer
authority from its name.

An app-session route id has the bounded form
`gsv1b~username~uid~expiresAt~nonce~signature`. The signature is a local
user-Kernel HMAC over the preceding fields. The Gateway parses the canonical
username and bounds before selecting `user:<username>`. Waking that object is
acceptable: the target must verify its active marker, the HMAC, expiry, and the
exact local session before the request body, cookie, or launch secret can grant
access. Tampering with the locator therefore fails at the selected target.

App cookies and user-Kernel client records additionally bind package,
entrypoint, session, client, uid, and expiry. The app frame and current Master
validation constrain each requested call. The Gateway strips caller-authored
identity headers and supplies runtime context only after target authorization.
Public routes have explicit package and entrypoint records; the Gateway never
searches for a user or trusts a route-supplied uid.

### OAuth and MCP callbacks

OAuth flow state is high entropy, expiring, and single use. The visible state or
callback path carries a canonical username only so the Gateway can select the
candidate user Kernel. The target checks its active marker, looks up the full
opaque state hash, verifies the recorded human Kernel owner and provider, and
atomically consumes the flow before exchanging the authorization code.

MCP OAuth uses the same selection-versus-authority rule. Username mismatch,
missing owner binding, state mismatch, replay, expiry, or provider mismatch
fails closed. Callback query values never select a run-as identity.

### Adapters

Adapter workers own platform-specific normalization and connection behavior.
The Master owns adapter-account and external-actor link uniqueness. Adapter
payload usernames, peer labels, uids, and reply addresses are untrusted.

Inbound delivery currently follows this path:

1. The platform event reaches its adapter worker and becomes a normalized
   `adapter.inbound` frame.
2. The adapter-specific Gateway entrypoint verifies the adapter scope and calls
   the Master with the frame.
3. The Master validates the bounded adapter/account/actor/surface fields and
   resolves the live identity link. If its known owner placement is
   `provisioning`, the Master idempotently completes it; only an `active`
   placement is invoked.
4. The target verifies that delivery came from the Master and that its own
   username/uid marker is active, then routes the message to a Process.

Unknown direct messages can receive an attempt-limited one-time link challenge;
unknown group or channel events are dropped. Link records carry a monotonic link
revision so unlinking cannot make an old route current again.

Outbound adapter replies also go through the Master. The user Kernel presents
the stored run route; the Master revalidates the actor link, adapter account,
owner uid, surface, and current link revision before invoking the adapter worker.
Adapters are transport surfaces, not durable agent runtimes.

This deliberately puts adapter content on the Master path today. If measurement
shows that to be a bottleneck, the intended optimization is a bounded ephemeral
link cache in user Kernels, populated and invalidated by Master push. It must not
become a durable authority replica, and cold starts or uncertain state must fall
back to the Master.

### Devices and credentials

A device record binds its owner username/uid, device id, and allowed operations.
Password and token verifiers remain Master-owned; a user Kernel receives only
the successful identity and authorization result. Driver tokens bind the owner,
device, role, advertised syscall subset, and expiry. A driver connects through
its owner's `/ws/<username>` route and cannot change owner, claim another device,
or route a response outside the registered request.

Password hashes, token hashes, provider keys, OAuth/MCP credentials, and personal
encryption material remain in Kernel-controlled state or a narrowly scoped
service. Raw tokens are returned only when issued and never enter prompts,
telemetry, adapter payloads, or another account's configuration.

### Files, repositories, and R2

The ship exposes one virtual filesystem and one Unix ownership namespace. A
path such as `/home/alice/report.md` is stored as an R2 object key behind GsvFs;
the path is not a separate database lookup and the `alice` segment does not
authorize access. The object remains owned by stable uid/gid/mode metadata.

`/home` itself is a filtered virtual directory. It exposes accounts the
controlling human may run as and other registered homes whose directory mode
allows the current process identity to list and traverse them. Opening,
searching, or mutating a child then applies the current process uid,
supplementary gids, every ancestor's mode, and the leaf mode. Account discovery
and file authority therefore remain separate decisions.

R2 does not interpret GSV's Unix metadata. Its `uid`, `gid`, `mode`, and
directory-marker fields are inert bytes until GSV validates them. User-reachable
R2 reads, ranges, streams, lists, writes, copies, renames, and deletes must go
through GsvFs or a narrow typed store with equivalent ownership checks. No
caller-controlled code receives a raw R2 binding.

The authorized storage boundary must:

- derive uid and supplementary gids from trusted Kernel identity;
- check execute permission on every ancestor, read and execute for list/search,
  and write and execute on a parent for child mutation;
- apply owner, group, and other bits consistently to exact, ranged, streaming,
  recursive, metadata, copy, and rename operations;
- restrict `chmod` and `chown`, derive ownership on creation server-side, and
  preserve it on replacement unless an authorized ownership operation changes
  it;
- follow symlinks without escaping checks or creating loops;
- authorize each descendant before recursive deletion and avoid partial
  deletion after denial;
- bind a mutation to the object version or absence that was authorized; and
- deny missing, malformed, or ambiguous ownership metadata.

Process media, archives, package artifacts, source overlays, and other internal
key families are not exemptions. They use GsvFs or a typed store that derives
the key and checks immutable owner scope on every operation.

Physical per-user R2 prefixes may help inventory, backup, or lifecycle tooling.
They are not the security boundary and do not replace Unix permission checks.

Repositories use the same logical ownership model even though RIPGIT is a
separate service. A repository has an immutable canonical owner username/uid
and explicit visibility or sharing rules. For Git HTTP, the Master performs
bounded credential, capability, repository-owner, and ACL admission. After
admission the Gateway forwards the request body or response stream directly to
RIPGIT. Packfiles and repository bodies do not transit the Master or a user
Kernel.

## Least privilege and sharing

A future publicly admitted human starts with a reviewed non-root baseline. They
receive no root, wildcard, membership-administration, service, driver, or
unrelated resource authority. A generic `users` group may grant ordinary syscall
capabilities, but it must not make private files, processes, devices, package
state, or credentials group-readable by default.

Personal agents receive a smaller run-as capability set than their human owner.
Packages receive reviewed entrypoint grants. Services and drivers receive
role- and target-bound tokens. Delegation can only narrow authority.

Normal cross-user file sharing uses explicit Unix groups, ownership, and modes.
Other resources use typed grants containing owner, grantee, resource, operations,
expiry, and revocation state. Absence or ambiguity denies access. Before public
registration, sharing and root overrides must be visible through the
release-gated security-audit ledger.

## AI-assisted admission

> Target only: no public application endpoint, commissioning charter, admission
> agent, or admission grant exists in the current implementation.

The intended commissioning flow lets root define:

- a versioned free-text ship charter expressing human intent; and
- a deterministic envelope containing registration mode, member and pending
  limits, application size and turn limits, rate and cost budgets, retention,
  grant lifetime, allowed outcomes, and failure behavior.

The chosen canonical username is explained as the applicant's permanent public
identity in the ship. A mutable display name is separate.

Applicant text is hostile prompt input. The admission model is an untrusted
recommender, not an authorization principal. It receives only the pinned public
charter, bounded application text, and a fixed output schema. It has no tools,
credentials, root context, filesystem access, account-creation syscall, or
shared applicant conversation.

Deterministic Master code validates the model response and chooses only among
fixed outcomes such as approve, deny, request more information, defer, or manual
review. Hard limits apply regardless of the recommendation. Timeouts, malformed
output, prompt injection, provider failure, and exhausted budgets fail closed or
enter explicit manual review; they never default to approval.

Approval produces a random, short-lived, one-time grant whose hash is bound to
the application, canonical username reservation, charter version, account tier,
and expiry. Idempotent provisioning reserves the username, allocates never-reused
uid/gid values, records baseline groups, initializes exactly
`user:<canonical-username>`, and activates it only after the Master and target
agree on username and uid. Passwords are supplied only during completion and
never enter the model request or application record.

The model cannot choose capabilities, groups, uid, gid, Kernel name, account
tier, rate limit, file mode, or resource grant.

## Abuse control, audit, and privacy

The Master durably limits login verification and link-challenge attempts. These
limits are authoritative because they need ship-wide identity semantics and
reliable counters across requests.

Cloudflare's [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
is useful only as an optional edge complement here. Its counters are local to a
Cloudflare location, asynchronously updated, intentionally permissive, and use
10- or 60-second periods. It may shed obvious bursts, but it must not replace
durable Master limits for login lockout, link-code consumption, admission, or
other security decisions.

Before public registration, limits must run before expensive work at multiple
dimensions: ship, privacy-preserving source key, canonical username,
application, account, credential, device, adapter account, and inference budget.
Registration, OAuth starts/callbacks, app launch, and public webhooks still need
the complete durable abuse and cost ledger.

Source addresses are not durable identity. Login controls retain only a
UTC-day HMAC-SHA-256 pseudonym derived with a per-ship random key; raw addresses
are not persisted. Source-target and source-work budgets must avoid allowing one
attacker to lock out an unrelated member. Cloudflare WAF and edge controls remain
defense in depth for distributed pressure.

No security-audit event store or user/root audit-query surface exists today.
The target ledger uses an explicit metadata allowlist: timestamp, action,
authenticated actor username/uid/role, typed target, policy or session hash
prefix, outcome, reason code, latency, and trace id. It excludes passwords, raw
tokens, OAuth codes, applicant statements, prompts, model messages, file
contents, tool arguments, and private paths.

Application text and model rationale are sensitive personal data with explicit
retention and deletion rules. Telemetry records aggregate outcomes and timings;
it does not become a second audit database or a cross-user content channel.

## Commissioning and upgrade contract

Clean commissioning creates root and the first human in the Master namespace,
then provisions `user:root` and the first human's user Kernel before normal
login. Privileged creation of another login-capable human performs the same
reservation, initialization, and activation sequence.

An existing deployment uses an in-place cutoff. Migration v16 runs in the
retained `singleton`, backfills `account_identities`, and records every
login-capable account in `user_kernels` as `provisioning`. The Master then
provisions `user:<canonical-username>` idempotently on demand and marks the
placement active before normal traffic is admitted. There is no normal-login
fallback through `singleton`.

The cutoff does not copy or destroy singleton-local runtime coordination. Old
connections, sessions, routes, schedules, OAuth/MCP rows, device records,
process/conversation registry rows, and callback state stay physically present
but dormant. A user Kernel starts that local coordination fresh; devices return
by reconnecting, and sessions or callback flows are reissued. Existing Process
DO storage is not rewritten or adopted implicitly.

The data planes keep their existing identities. R2 objects retain their bucket,
paths, and uid/gid/mode metadata; ripgit repositories retain their paths;
AppRunner data remains in `app:<actorUid>:<packageId>`; and Master-owned
adapter accounts and identity links remain in `singleton`. The cutoff replaces
no Master, bucket, or storage namespace. Missing or malformed filesystem
ownership still fails closed and requires explicit root repair.

## Adversarial validation

Validation includes clean commissioning and representative upgraded deployments
with root and at least two non-root humans in different user Kernels. Required
attacks include:

- Unicode, case, whitespace, and percent-encoding normalization collisions;
  attempted username rename/reuse; uid/gid reuse; direct addressing of an
  unprovisioned Kernel; and concurrent provisioning completion;
- forged internal Kernel names, username/uid pairs, placements, provisioning
  inputs, and caller-authored internal headers;
- app-session locator and HMAC tampering, oversized locators, uid mismatch,
  expiry, cookie theft, replay, and direct AppRunner addressing;
- cross-user Process history/control, IPC, HIL, signals, config, package RPC and
  SQL, app sessions, OAuth, schedules, media, adapters, and devices;
- filesystem traversal through ancestors, symlinks, ranges, streams, search,
  copy, rename, recursive delete, malformed metadata, group changes, and
  concurrent replacement;
- attempts to reach internal R2 keys or invoke a raw R2 binding from any
  user-controlled path;
- RIPGIT owner substitution, repository visibility errors, workspace owner
  confusion, and source-overlay collisions;
- OAuth state swapping/replay, callback/provider mismatch, adapter uid spoofing,
  stale link revisions, link-code guessing/replay, and service-token misuse;
- admission prompt injection, malformed model output, provider failure, budget
  exhaustion, policy replacement, grant replay, and interrupted provisioning;
  and
- audit and telemetry inspection proving prohibited credentials and content are
  absent.

Positive tests prove explicit owner/group sharing and intentional root repair.
Failure injection covers Durable Object eviction, disconnects, duplicate
delivery, R2/RIPGIT failure, model failure, and retryable provisioning steps.
Tests assert that routes, bodies, reservations, credentials, and temporary state
reach one terminal outcome.

Load tests prove that one hot user's connections, device traffic, processes, and
model streams affect that user's Kernel rather than another user or the Master.
Adapter traffic is separately load-tested because it intentionally traverses
the Master today. All Master checks must be bounded, and adapter bodies must have
clear cancellation and cleanup ownership.

## Public-registration release gates

Registration remains `closed` by default, including after upgrade. No public
application or account-creation endpoint is enabled until all gates pass:

1. **Identity namespace:** immutable, permanently reserved canonical usernames;
   unique, never-reused uid/gid values; explicit account kind/state; mutable
   display names; terminal deletion behavior; generic authentication errors.
2. **Provisioning and routing:** `/ws` is commissioning-only;
   `/ws/<username>` selects exactly `user:<username>`; only the Master can reserve
   and activate it; a `provisioning` object serves no work and transitions only
   through the Master-owned ensure operation; unknown and failed objects fail
   closed.
3. **Master authority:** `singleton` is the only writer for global identity,
   capabilities, configuration, packages, links, admission, and cross-user
   grants. User Kernels contain no authority replicas and all typed RPCs pass
   forged-source and field-redaction tests.
4. **Filesystem enforcement:** every user-reachable R2 operation passes through
   an authorized boundary; modes, ancestors, symlinks, streams, recursive
   operations, and conditional mutation pass cross-user tests.
5. **Resource isolation:** Processes, packages, RIPGIT, media, devices, adapters,
   OAuth, schedules, credentials, and app sessions enforce immutable ownership;
   no public account receives root, wildcard, or ship-administration authority.
6. **Admission safety:** versioned root charter and deterministic envelope,
   strict model schema, tool-less inference, single-use grants, idempotent
   provisioning, manual failure policy, and password/model separation are done.
7. **Abuse resistance:** login, application, completion, linking, callbacks,
   public apps, and inference have durable Master rate/cost limits tested under
   concurrency and provider failure. Edge limiting remains complementary.
8. **Audit and disclosure:** identity and root actions are attributable;
   redaction, retention, deletion, provider disclosure, incident procedures,
   permanent public usernames, and the ship-root trust relationship are
   documented and tested.
9. **Operations:** an upgraded ship completes in-place user-Kernel provisioning
   without singleton runtime fallback or dual writers; old runtime rows stay
   dormant, preserved data planes remain authorized at their existing names,
   and failed provisioning has a tested recovery path.
10. **Adversarial E2E:** the validation matrix passes on a clean ship and a
    representative upgraded ship with root and two mutually untrusted humans,
    including replay, races, eviction, hot-shard load, and partial failure.

Physical per-user R2 prefixes are not a release gate. Complete authorization is.
Model quality is not a substitute for a deterministic gate. Until the boundary
is complete, GSV may experiment with charter authoring and root-reviewed
applications, but it must not expose autonomous public account creation.

## See also

- [Security Model](./security-model.md)
- [Architecture Overview](./index.md)
- [The Agent Loop](./agent-loop.md)
- [The Adapter Model](./adapter-model.md)
- [Process IPC and Scheduler](./process-ipc-and-scheduler.md)
