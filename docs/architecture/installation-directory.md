# Installation directory and onboarding

The installation directory is the operator-to-gateway identity contract.
Accounts owns installation identity, hostnames, ownership records, and
lifecycle state. The Kernel owns local accounts, credentials, roles, and
ordinary syscall authorization. Resolving an installation establishes which
Kernel may receive a request; it does not sign a person into that Kernel.

This document describes the implemented directory and onboarding interfaces.
The [hosting consolidation plan](../../engineering/hosting-consolidation-spec.md)
adds public Accounts, owner recovery, and complete data deletion in later
slices. Those operations must not be inferred from a directory lookup.

## Public interfaces

The contracts are exported from
[`services/directory.ts`](../../packages/gsv/src/services/directory.ts) and
[`services/onboarding.ts`](../../packages/gsv/src/services/onboarding.ts) in
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
| `trialing`, `past_due` | Refused. | Refused; these retained schema values do not imply a commercial admission exception. |
| `restricted` | Refused while identity and data are retained. | Refused. |
| `cancelled`, `retained`, `deleting`, `deleted` | Refused. | Refused. |

The gateway's [routing implementation](../../workers/gateway/src/installation/routing.ts)
accepts `active`, or `provisioning` when explicitly resolving a setup route.
Unknown hosts must not allocate Kernel state. Directory failures must fail
closed rather than falling back to a different installation.

The [lifecycle gate](../../workers/gateway/src/installation/lifecycle.ts)
also applies to work entering through existing WebSockets, adapters,
inference, Process ticks, and schedules. Suspending an installation does not
erase data or recursively cancel work already admitted; durable work
rechecks the gate before new admission and may resume after reactivation.

The currently supported standalone deployment retains its explicit
`singleton` projection until the planned cutover. A failed directory lookup
in a deployment with a directory never falls back to that projection.

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
memberships or a grant of local permissions. Existing registry-principal
records remain bookkeeping until the separate verified-owner linking flow
is implemented. Successful setup does not assign that principal a Kernel uid.

The legacy `role` and `local_uid` columns are being retired. They do not
govern current local admission. The inference usage ledger's `local_uid`
records the actor of a request and is unrelated; it remains intact.

## Reset and deletion

An installation reset creates a new immutable id, moves the canonical
hostname, retires old routing, and records the old installation's data as
pending deletion. It preserves the reset operation identity so retries
recover the same replacement instead of creating another one. Existing
policy copying and disablement are owned by the current Accounts
implementation until their service separation lands.

Pending deletion means data remains stored. Current reset does not erase
Kernel, Process, Conversation, R2, ripgit, adapter, mail or inference state.
The consolidation deletion slice adds a durable coordinator and per-owner
quiesce/erase acknowledgements, including old pending resets. It must retain
resource inventories until children are erased and prevent stale writes
from recreating user data. Retiring routing alone is not erasure.

Root recovery is also a separate trusted operation in the consolidation
plan. Accounts authenticates ownership and authorizes it; the Kernel changes
credentials. Possession of a directory lookup binding does not expose that
future incoming recovery capability.

## Validation and schema rollout

Keep tests at both ends: Accounts tests cover reservation races, claim
binding, expiry/reissue, activation, reset idempotency and rollback; gateway
tests cover unknown-host rejection, state gates, immutable addressing, and
cross-installation isolation. Test both an upgraded database containing
ownership rows and a fresh instance.

Ownership-column retirement uses two deployments because migrations run
before the replacement Worker is active. First make the legacy role column
default to `owner` and stop writing or reading both obsolete columns. Both
old and new Workers work with that intermediate schema. After the new Worker
is deployed and older requests are drained, a subsequent migration removes
both columns and their obsolete uid uniqueness constraint. Keep the removal
out of the first deployment's applied migration directory. Existing
principal/installation foreign keys and ownership rows survive both steps.

Shipped migration files are immutable. Cloudflare D1 enforces foreign keys
during migrations; a table rebuild must preserve the relationships rather
than disabling them. See [D1 foreign-key behavior](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
