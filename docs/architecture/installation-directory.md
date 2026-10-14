# Installation directory and onboarding

The installation directory is the operator-to-gateway identity contract.
Accounts owns installation identity, hostnames, ownership records, and
lifecycle state. The Kernel owns local accounts, credentials, roles, and
ordinary syscall authorization. Resolving an installation establishes which
Kernel may receive a request; it does not sign a person into that Kernel.

This document describes the directory and onboarding interfaces supplied by
public Accounts in `workers/installations/`. Accounts also owns verified owner
identity, root-recovery authorization and deletion coordination. Each operation
has its own authority; none follows merely from possession of a lookup binding.

## Public interfaces

The contracts are exported from
[`services/directory.ts`](https://github.com/deathbyknowledge/gsv/blob/main/packages/gsv/src/services/directory.ts) and
[`services/onboarding.ts`](https://github.com/deathbyknowledge/gsv/blob/main/packages/gsv/src/services/onboarding.ts) in
`@humansandmachines/gsv`. A deployment supplies implementations through
trusted Worker service bindings.

| Method | Input and result | Ownership |
|---|---|---|
| `resolveHostname(hostname)` | Returns the registered installation identity and state, or `{ found: false }`. Unknown and retired hostname records do not resolve. | Accounts normalizes and resolves hostnames; the gateway supplies the request hostname. |
| `resolveInstallation(installationId)` | Returns that exact immutable identity and state, or `{ found: false }`. | Internal callers retain a validated id in owned state or recover it from a trusted route. |
| `authorizeInstallationOnboarding({ installationId, token })` | Returns the matching claim id and installation identity, or `{ ok: false }`. | The Kernel supplies its resolved installation id and the setup capability. Accounts validates its hash, expiry, revocation and provisioning state. |
| `completeInstallationOnboarding({ claimId, installationId })` | Completes the admitted setup claim and returns the installation id with state `complete`. | The Kernel creates local credentials first; Accounts consumes the claim and activates installation routing. |

A found identity contains `installationId`, `handle`, `canonicalOrigin`, and
`state`. Only `installationId` is the security identity. A handle or hostname
may move to a replacement installation after reset; old credentials and
delayed work remain scoped to the retired id.

Public clients cannot choose an installation id for an ordinary request.
The gateway resolves the request hostname before addressing a Kernel.
Adapters resolve a durable, generation-fenced identity link; background work
uses its stored installation identity. Passing an arbitrary id through a
service call is not a replacement for those admission checks.

## Resolution and admission

Directory resolution and permission to perform work are separate results.
A known inactive installation can be returned by the directory so trusted
administration can inspect it; ordinary work remains gated.

| Installation state | Ordinary work | Setup routing |
|---|---|---|
| `active` | Admitted subject to Kernel authentication and capabilities. | Existing installation routing. |
| `provisioning` | Refused. | A setup-capable route may address the Kernel, which must validate the installation's onboarding claim before accepting setup. |
| `reserved` | Refused. | Not yet routable for setup. |
| `trialing`, `past_due` | Refused. | Refused; retained schema values, not routing states. |
| `restricted` | Refused while identity and data are retained. | Refused. |
| `cancelled`, `retained`, `deleting`, `deleted` | Refused. | Refused. |

The gateway's [routing implementation](https://github.com/deathbyknowledge/gsv/blob/main/workers/gateway/src/installation/routing.ts)
accepts `active`, or `provisioning` when explicitly resolving a setup route.
Unknown hosts must not allocate Kernel state. Directory failures must fail
closed rather than falling back to a different installation.

The [lifecycle gate](https://github.com/deathbyknowledge/gsv/blob/main/workers/gateway/src/installation/lifecycle.ts)
also applies to work entering through existing WebSockets, adapters,
inference, Process ticks, and schedules. Suspending an installation does not
erase data or recursively cancel work already admitted; durable work
rechecks the gate before new admission and may resume after reactivation.

All deployments require directory resolution. There is no singleton fallback,
even when the binding is absent. Historical standalone data remains outside
current routing; see the [retirement guide](../how-to/standalone-retirement.md).

## Setup and ownership

Accounts reserves an installation for a verified active principal and issues
a one-time setup capability for that installation. The browser reads the
fragment and removes it from the URL; Accounts stores a hash, and the
Kernel creates the local username, password and other credentials. Reissuing
a claim invalidates its predecessor. Provisioning calls and completion are
installation-scoped; replay of a consumed authorization cannot admit another
setup. Kernel-owned pending completion is retained for retry when an
Accounts call fails.

An ordinary connection to a provisioning space returns `details.setupRecovery`
instead of presenting it as a ready account. Expired setup authorization returns
the same recovery signal. The operator may bind `GSV_OWNER_SIGNUP_URL` to its
owner signup page with `?resume=1`; the public composition supplies it when owner
email sign-in is configured. Accounts sets `ownerSetupRecovery` in the directory
only for an installation created through verified-owner signup. The Kernel
includes the recovery URL only for those spaces; this link carries no authority.
A verified owner resumes the same provisioning operation and receives the same
setup authorization while it remains valid. Accounts derives that bearer using
its stable owner-authentication secret and the claim's issuance times; D1 stores
only the hash. Concurrent resumes cannot invalidate each other. Expiry rotates
the bearer while preserving the claim identity retained by the Kernel.
Clients clear rejected capabilities so an
already activated space returns to ordinary sign-in. Operator-issued setup links
instead direct the person to request a replacement from the operator.

The directory's `memberships` rows are ownership records, with an
installation id, principal id, state, and creation time. They are not Kernel
memberships or a grant of local permissions. Linking a verified owner requires
current Kernel root authorization and fresh owner verification. Native email
and external-provider identities remain separate even when email addresses
match. Successful setup does not assign that principal a Kernel uid.

The legacy `role` and `local_uid` columns do not govern local admission. The
inference usage ledger's `local_uid` records the actor of a request and is
unrelated.

## Open registration

`InstallationSignup` owns verified-owner creation. `POST /owner/api/spaces` accepts
an operation ID and handle under the owner's bearer session. The client persists
the operation before transmission; concurrent retries return the same installation.
Accounts atomically limits self-service creation to one non-deleted, non-cancelled
Space per owner, without limiting operator-created or already-owned Spaces.
The owner session lists unfinished setups independently of browser storage.

The existing provisioning ledger owns progress and diagnostic references.
`installations.owner_setup` identifies setups an owner may resume. The forward
migration preserves this marker for Spaces created through legacy signup codes;
an upgrade trigger also covers old workers completing signup during rollout.
Claim issuance is versioned at the database boundary: an old worker must retry
instead of overwriting a new setup token. The migration retains the hash and
original expiry of a capability issued before this fence, so an in-flight old
response remains usable after owner setup resumes. This does not extend its
lifetime. An explicit operator reissue invalidates both bearers.
The retired invitation table remains historical data, never admission authority.
Old Desktop clients retain owner sign-in; their retired registration endpoints
return an instruction to update the app.

Public operators enable registration with `installations.openRegistration` in
the deployment composition (`GSV_SIGNUP_ENABLED=true` in Accounts). Commercial
compositions assign their configured default plan through the signup policy
before setup authorization is issued. Plan assignment is idempotent and preserves
later operator edits. Closing registration prevents new allocations while
allowing already-admitted setups to finish.
An optional signup email policy rejects new native owner credentials before mail
delivery and again during verification, and rejects new Space allocations before
reservation. Existing credentials can still sign in and admitted setups can resume.
The managed composition uses this to prevent GSV mailboxes from registering more Spaces.

Contact invitations remain entirely Kernel-owned. The browser carries a pending
contact link through signup and local setup, then presents the normal acceptance
and message-handling choice. Creating, cancelling or accepting a contact invitation
does not reserve, consume or refund a signup place.

## Reset and deletion

An installation reset creates a new immutable id, moves the canonical
hostname, retires old routing, and records the old installation's data as
pending deletion. It preserves the reset operation identity so retries
recover the same replacement instead of creating another one. Existing
policy copying and disablement remain service-owned.

Pending deletion means data remains stored. Accounts durably coordinates
quiesce and erase operations across the captured resource inventory, including
pending resets inherited from an older source. Kernel, Process, Conversation,
R2, ripgit, adapters, mail, inference and cloud instances report their own cleanup receipts.
Instance coordinators are installation-owned resources in discovery and deletion;
they do not require adapter peer-inventory import. Their lifecycle owner stops
browsers and erases profiles and temporary files before confirming live erasure.
Missing inventory or owner evidence prevents a claim of completed erasure.
Stale work cannot recreate data after its owner has retired the identity.

Live erasure and retained copies are separate states. Backups, queues, telemetry
and provider logs require operator-specific retention or deletion evidence;
routing retirement alone proves neither. See the
[operator cleanup guide](../how-to/operate-gsv.md#connect-services-and-verify-cleanup).

Root recovery authenticates the current verified owner and requires fresh
verification bound to the exact recovery attempt. An ordinary owner session is
insufficient. Accounts authorizes the operation; the Kernel changes local root
credentials. Verification mail is independent of the space being recovered.

## Schema

Shipped migration files are immutable. Cloudflare D1 enforces foreign keys
during migrations; a table rebuild must preserve the relationships rather
than disabling them. See [D1 foreign-key behavior](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
