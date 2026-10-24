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
delayed work remain scoped to the retired id. A handle is one lowercase DNS
label. Accounts refuses handles reserved for the deployment's own hostnames:
`deploy`, `docs`, `install`, `pds` (the open-network host), `signup`,
`staging` and `www`.

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

Inside a Kernel or Process, the gate remembers an `active` answer for one
minute and shares one directory lookup among concurrent requests, so ordinary
traffic does not query Accounts per frame. A refusal is never remembered and
clears an earlier confirmation. Calls that authenticate or grant credentials
(`sys.connect`, device pairing and account recovery, and the recovery and
owner-link authorizations Accounts requests) always ask Accounts. Deletion
quiescence clears the confirmation. A lookup that fails or takes longer than
two seconds is recorded as a diagnostic and fails closed with a retryable
"Ship is briefly unreachable" error, because an outage cannot be told apart
from a suspension. Accounts does not notify a Kernel when it restricts or
resets an installation, so already-authenticated traffic observes those
changes within a minute.

Accounts also holds an operator binding to the Gateway for the Ship health
view in administration. The Gateway resolves the installation through the
directory first and answers only for an active or suspended Ship, so the view
never allocates Kernel state. Its answer is validated against a public contract
that carries counts, times, names and outcomes, never content.

All deployments require directory resolution; a missing directory binding fails
closed. Historical standalone data remains outside
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
already activated space returns to ordinary sign-in. Operator-issued activation links
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

Operators manage reserved and blocked public usernames at **Administration → Signup**
(`/admin/signup`). Accounts stores both lists; edits take effect immediately without
redeployment. Enter one name per line or separate entries with commas (up to 500
per list). Each form field accepts up to 16,000 characters; both lists can be saved
together at that size, including accented names. Reserved names are available only
for operator-controlled installations created through administration. Blocked names
are unavailable for all new allocations,
including operator creation, and take precedence over reserved entries.
Configured service hostnames and built-in routes remain protected.

Policy matching compares the **entire** name after lowercasing, Unicode NFKD accent
removal, and removal of hyphens, underscores, dots and whitespace. Both candidates
and list entries use this comparison. It never changes stored usernames, syntax
rules or uniqueness: an ordinary `alice-smith` remains distinct from `alicesmith`.
Both lists start empty. Operators add their own entries in administration and
can add targeted spelling evasions as encountered. Context-dependent terms should
be assessed when reported rather than automatically blocked solely for an
ambiguous meaning.

Availability reports both categories as unavailable to signup. Accounts checks
policy atomically when reserving a new installation, preventing direct creation
or concurrent list edits from bypassing the check. Existing installations, admitted
setup retries and resets retain their handles. There is no public handle rename
or new-installation import path today; any such path must enforce this same policy
before assigning a new public handle, without using its normalization for uniqueness.
Only authenticated operators can edit the lists, with same-origin mutation checks
and an audit event when operator auditing is configured.

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
R2, ripgit, adapters, mail, inference, cloud instances and the open-network host report their own cleanup receipts.
Instance coordinators are installation-owned resources in discovery and deletion;
they do not require adapter peer-inventory import. Their lifecycle owner stops
browsers and erases profiles and temporary files before confirming live erasure.
Cloud computer objects also appear as `instance-computer` resources. Their owner
destroys the container before confirming erasure or releasing its reservation;
late start and health completions cannot reactivate a retired object.
The open-network host's repository objects and its one host object need no
import either. Its owner tells relays the account is deleted and tombstones the
Ship's DID; see [deletion on the open network](open-network.md#deletion).
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

For upgrades from the seeded username policy, keep migration `0028_username_policy.sql`
unchanged and apply `0029_remove_username_policy_starters.sql` before serving the
updated Accounts worker. Fresh installations finish with empty lists. The forward
migration removes only exact starter rows, preserving added or modified entries.
If the audit log records a completed or pending operator policy save, it preserves
the entire policy, including starter names the operator retained.

## Preferred domains and accepted aliases

The operator supplies a primary domain for new installations and an explicit list
of legacy domains. When Accounts receives an unknown hostname on the primary
domain, it may insert an alias only if the same handle already has a non-retired
canonical hostname on a configured legacy domain. The inserted row points to the
recorded installation ID and inherits its hostname state. The lookup does not
allocate a Kernel, change a canonical origin, or claim an arbitrary wildcard.
The origin's parsed hostname must match that registration; configured schemes
and ports remain intact. The insert rechecks the installation and origin so a
concurrent reset cannot attach the alias to the previous identity. An existing
retired row prevents recreation.

Reset preserves the recorded canonical origin and moves all active accepted
hostnames atomically to the replacement installation. Provisioning and activation
advance those hostnames together. Installation lifecycle admission still applies
to every alias. New primary-domain installations do not acquire legacy aliases.
DNS and Cloudflare routes remain owned by the operator composition.
