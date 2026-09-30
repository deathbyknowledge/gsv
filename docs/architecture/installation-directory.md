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

The directory's `memberships` rows are ownership records, with an
installation id, principal id, state, and creation time. They are not Kernel
memberships or a grant of local permissions. Linking a verified owner requires
current Kernel root authorization and fresh owner verification. Native email
and external-provider identities remain separate even when email addresses
match. Successful setup does not assign that principal a Kernel uid.

The legacy `role` and `local_uid` columns do not govern local admission. The
inference usage ledger's `local_uid` records the actor of a request and is
unrelated.

## Reset and deletion

An installation reset creates a new immutable id, moves the canonical
hostname, retires old routing, and records the old installation's data as
pending deletion. It preserves the reset operation identity so retries
recover the same replacement instead of creating another one. Existing
policy copying and disablement remain service-owned.

Pending deletion means data remains stored. Accounts durably coordinates
quiesce and erase operations across the captured resource inventory, including
pending resets inherited from an older source. Kernel, Process, Conversation,
R2, ripgit, adapters, mail and inference report their own cleanup receipts.
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
