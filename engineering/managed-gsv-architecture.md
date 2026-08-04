# Managed GSV Architecture

Status: design proposal. This document records the target architecture for a
managed GSV service. The current implementation remains a single-installation
deployment until the migration described here is complete.

## Decision summary

Managed GSV should run the same trusted Gateway, Kernel, Process, filesystem,
and agent code for every customer in normal Cloudflare Worker deployments. It
does not need Workers for Platforms merely to host multiple GSV installations.

The managed service adds two things around the existing runtime:

- a platform control plane for global accounts, installation provisioning,
  hostname registration, membership, recovery, and billing; and
- an immutable installation identity propagated through every shared storage,
  Durable Object, repository, adapter, and background-work address.

One GSV installation is the outer security, ownership, data, and billing
boundary. Users, groups, agents, UIDs, capabilities, homes, processes, devices,
and adapter links remain local to that installation.

The product can call this boundary **your GSV**. Implementation code should use
**installation**. Do not call it a tenant, deployment, home, or username:

- `tenant` describes the hosting business rather than the product;
- `deployment` is already an infrastructure concept, while many installations
  share one Worker deployment;
- `home` already means an account filesystem such as `/home/alice`; and
- `username` identifies a local account, not the GSV installation.

Workers for Platforms remains relevant only if customers later need to upload
or control their own Worker code or require per-customer Worker bindings and
execution policy. It is not required for per-installation Durable Objects and
data isolation when every installation runs the same trusted GSV code.

## Core invariants

1. Every request, background operation, process, repository, and external
   adapter action resolves an immutable `installationId` before it resolves a
   local UID, username, PID, repository, or device.
2. Mutable public names never serve as durable identities.
3. Installation identity comes from a trusted hostname lookup, provisioned
   Durable Object name, or internal service-binding context. Never trust an
   `installationId` supplied by an ordinary request body or model-facing tool.
4. An unknown hostname returns `404` before a Kernel Durable Object is created.
5. Local UIDs and usernames are unique only inside their Kernel. UID `1000` and
   username `alice` can legitimately exist in every installation.
6. Shared backing services expose installation-scoped clients to runtime code.
   Domain code does not receive raw global R2, Process, ripgit, or adapter
   namespaces when a scoped alternative is possible.
7. Public and model-facing paths remain stable. Physical installation prefixes
   do not leak into `/home`, `/var`, `/public`, repository slugs, or PIDs.
8. Billing state can limit new cost-generating work, but it does not silently
   delete data or prevent authentication, export, billing repair, or teardown.
9. Managed and standalone GSV share the same installation-local runtime. Only
   global account authentication, hostname resolution, provisioning, and
   billing differ.

## Vocabulary and identity layers

Managed GSV has three distinct identity layers:

| Concept | Scope | Example | Owner |
|---|---|---|---|
| Platform principal | Global managed service | verified email, passkey, `principalId` | Managed control plane |
| GSV installation | One GSV security and billing boundary | `installationId`, `hank.gsv.space` | Installation Kernel plus platform directory |
| Local GSV account | Unix-like identity inside an installation | `alice`, UID `1000` | Installation Kernel |

A platform principal can own multiple installations and can be invited into
other installations. An installation can have multiple human members. A
membership maps a platform principal to one local human UID in one
installation. Local agent and service accounts remain Kernel-owned identities
and do not require global platform principals.

The first owner's installation handle and local username may default to the
same text for a simple onboarding experience, but they are independent fields:

- the handle is globally unique, DNS-safe, and may change;
- the local username is unique only inside the installation and owns a home;
- the immutable installation ID survives either rename; and
- display names are separate mutable presentation.

The existing multi-user model should remain. It provides real runtime semantics
for human accounts, personal agents, delegated agents, groups, run-as identity,
filesystem permissions, device ownership, and capabilities. Managed GSV should
present one human owner by default and reveal multi-user management through an
explicit invitation or advanced flow rather than deleting the underlying
model.

## Target topology

```text
accounts.gsv.space
  Managed control-plane Worker
    - global authentication and sessions
    - installation and hostname directory
    - memberships and ownership
    - provisioning state
    - billing-provider customer and subscription state
    - transactional email and recovery
    - private provisioning authority

*.gsv.space
  GSV Gateway Worker
    - hostname resolution
    - static desktop shell
    - WebSocket and HTTP entrypoints
    - Kernel and Process Durable Object namespaces
    - installation-scoped R2 access
    - ripgit and adapter service bindings

ripgit and adapter Workers
  Internal service bindings
    - installation-scoped repository and adapter Durable Objects
```

These are ordinary Workers. Keeping the managed control plane separate prevents
billing-provider secrets, global account records, recovery authority, and
provisioning credentials from entering the agent runtime environment. The
Gateway should receive only narrow operations such as hostname resolution,
entitlement lookup, and login-ticket verification.

## Installation identity

The installation-local identity is:

```ts
type InstallationIdentity = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
};
```

`installationId` is opaque, immutable, and generated independently of the
handle. `handle` is the default public routing label. `canonicalOrigin` is a
normalized HTTP(S) origin, not an arbitrary URL with a path, query, or fragment.
User-facing endpoints such as `/ws`, `/oauth/callback`, and `/git/...` derive
from this one origin.

The Kernel should use `installationId` as its Durable Object name. The Agent
name, and current Durable Object `ctx.id.name` behavior for name-derived
objects, make that identity available during requests and alarms without an
ambient incoming hostname.

The Kernel owns its installation-local identity metadata so standalone GSV can
configure the same record without a managed directory. The managed directory
owns the global routing projection from accepted hostname to installation ID.
A handle rename is therefore a coordinated operation: reserve the new hostname,
update the Kernel's canonical identity, make the new hostname canonical, retain
the old hostname as a temporary alias or redirect, and release it only under an
explicit reuse policy.

## Hostname directory and request routing

The wildcard route and DNS record deliver all candidate subdomains to the
Gateway, but DNS is not the installation directory.

For every installation-scoped request, the Gateway performs:

```text
normalized Host
  -> reject apex and reserved platform hosts
  -> directory lookup: hostname -> installationId and lifecycle state
  -> reject unknown, provisioning, deleted, or invalid hosts as appropriate
  -> address KERNEL by installationId
  -> forward the request with trusted installation context
```

Never call `KERNEL.getByName(handle)` for an arbitrary wildcard hostname. A
request to a random subdomain would otherwise allocate durable state and could
enter first-boot setup. Registration must precede Durable Object creation.

The directory should use an atomic unique constraint for normalized hostname
claims. A separate availability check followed by an insert has a race. ASCII
lowercase letters, digits, and internal hyphens are an appropriate initial
handle alphabet. Reserve platform names such as `www`, `accounts`, `auth`,
`api`, `admin`, `docs`, `install`, `deploy`, `status`, `support`, and `mail`.

The directory may cache positive and negative routing results, but the durable
database remains authoritative. Provisioning, rename, suspension, and deletion
flows must have explicit cache invalidation or bounded staleness.

## Resource isolation

| Resource | Current logical address | Managed physical address |
|---|---|---|
| Kernel DO | `singleton` | `installationId` |
| Process DO | `pid` | `installationId/pid` |
| R2 object | `home/alice/...` | `installations/{installationId}/home/alice/...` |
| Process media | `var/media/{uid}/{pid}/...` | `installations/{installationId}/var/media/{uid}/{pid}/...` |
| Public file | `public/...` | `installations/{installationId}/public/...` |
| ripgit DO | `{owner}/{repo}` | `{installationId}/{owner}/{repo}` |
| Adapter DO | adapter account identifier | `{installationId}/{adapterAccountId}` |

Opaque UUIDs reduce accidental Process collisions but do not constitute an
authorization boundary. The installation component is still required so a
leaked PID, stale route, or caller bug cannot address another installation's
Process object.

Composite names must use a canonical collision-free encoding. Public PIDs and
repository slugs do not change; only internal Durable Object names change.

## R2 storage

Use one shared R2 bucket per deployment environment initially, not one bucket
per installation or local user. The top-level prefix is the installation
boundary:

```text
installations/{installationId}/
  home/
  root/
  public/
  tmp/
  var/
  ...
```

The runtime should create one installation-scoped storage object and pass it to
the filesystem, Process, media, archive, setup, and cleanup layers:

```ts
const storage = createInstallationStorage(env.STORAGE, installationId);
```

The scoped implementation owns every key-bearing operation, including `get`,
`head`, `put`, `delete`, `list`, multipart upload creation and resume, and any
copy or cleanup operation. `list` always adds the installation prefix and
returns logical keys with that prefix removed. Callers continue to see
`home/alice/...`, not the physical bucket address.

This boundary should be a domain interface rather than a convention repeated at
call sites. An R2 binding grants the Worker access to the whole bucket; object
metadata containing UID/GID does not prevent a caller from presenting a foreign
key. No installation-scoped component should retain a raw bucket binding that
allows it to bypass the prefix.

Within the installation prefix, the existing UID, GID, mode, and capability
model continues to isolate local accounts. Prefixing each human account as the
outer boundary would duplicate the filesystem permission model and interfere
with root, shared groups, public files, archives, and cross-account workflows.

The installation prefix also provides the unit for export, storage accounting,
retention, and eventual deletion. Deployment-owned immutable web assets, if
stored outside Workers static assets, must use a separate explicit global
namespace that is never mounted into an installation filesystem.

## Process routing

The Kernel registry continues to expose an opaque PID such as `proc:<uuid>`.
Internally, all Process lookup functions require both installation ID and PID:

```ts
getProcess(installationId, pid)
  -> PROCESS.getByName(encode(installationId, pid))
```

A Process is initialized with its parent installation ID and persists or
asserts it as part of its durable identity. Every Process-to-Kernel path,
including syscalls, cancellation, model transport, alarms, IPC, schedules, and
late cleanup, uses that parent identity. Background work cannot depend on an
HTTP hostname being present.

Kernel-to-Process helpers should receive installation-scoped routing context
rather than import a global singleton helper. The Kernel remains responsible
for checking local process ownership and capabilities before resolving the
physical Process object.

## ripgit isolation

The public repository identity remains `{owner}/{repo}` inside one GSV. The
internal ripgit identity becomes `{installationId}/{owner}/{repo}`.

`RipgitRepoRef` should either contain a trusted installation ID internally or be
resolved through an installation-scoped `RipgitClient`. Ordinary syscall and
model callers must not choose the installation component. The authenticated
Kernel adds it after authorizing the local repository operation.

Repository Durable Object names, import state, public Git HTTP proxying, home
repositories, workspaces, skills, knowledge, and source overlays must all use
the same scoped identity. Two installations may then both contain `alice/home`
without sharing a Repository DO.

The public remote stays intuitive because the hostname already identifies the
installation:

```text
https://hank.gsv.space/git/alice/home.git
```

## Adapter isolation

Adapter workers do not receive a user hostname when a messaging platform emits
an inbound event. Each connected external adapter account therefore needs a
durable mapping to one installation ID.

Adapter Durable Object names and Gateway service-binding calls carry the
installation ID derived from that trusted mapping. The Kernel then applies its
existing local account, actor-link, surface, and capability checks. A frame from
an adapter cannot select an arbitrary installation.

The product must decide whether one external account may attach to multiple GSV
installations. The safest initial rule is exclusive attachment with an explicit
unlink/relink flow. Supporting shared attachment later requires routing each
conversation or actor to an installation without ambiguity.

## Managed accounts and Kernel users

The managed platform authenticates global humans; the Kernel authorizes local
identities. A membership record bridges the two:

```ts
type InstallationMembership = {
  installationId: string;
  principalId: string;
  localUid: number;
  role: "owner" | "admin" | "member";
};
```

The platform role governs managed-service operations such as billing ownership,
hostname changes, recovery, invitations, and deletion. The Kernel's local UID,
groups, and capabilities govern GSV operations. Do not infer one authority from
the other without an explicit mapping.

Hosted browser authentication should not require a second unrelated local
password. The platform issues a short-lived, installation-bound, single-use
login handoff that the target hostname exchanges for a host-scoped GSV session
or connection credential. The Kernel resolves that verified principal through
membership to the local UID.

Do not set a general session cookie for `Domain=.gsv.space`. Keep the platform
session host-only on the account/auth origin and the installation session
host-only on its GSV origin. A one-use handoff avoids sharing a bearer credential
with every customer subdomain.

Standalone GSV keeps local password and token authentication. Managed and
standalone authentication both resolve to the same `ConnectionIdentity` before
Kernel authorization.

## Signup and provisioning

The initial managed signup flow is:

1. Create or authenticate a global platform principal.
2. Verify a recovery-capable email address and register a primary credential.
3. Choose and atomically reserve an installation handle.
4. Create a trial entitlement or hosted checkout session associated with the
   proposed installation ID.
5. Treat the verified billing webhook, not a browser success redirect, as the
   authority to continue paid provisioning.
6. Create the Kernel by immutable installation ID through an internal
   provisioning operation.
7. Initialize installation identity, the first local human account, membership,
   filesystem layout, personal agent, and default configuration.
8. Activate the hostname in the directory only after Kernel provisioning
   succeeds.
9. Issue a one-time login handoff and enter the new GSV.

Abandoned handle reservations expire. Failed provisioning remains resumable and
idempotent by installation ID. Replaying a successful payment or provisioning
request must not create a second Kernel, membership, or subscription.

The current open `sys.setup` contract remains appropriate for a user-owned
standalone deployment but not for wildcard managed hosting. Managed mode must
reject public first-boot ownership claims. The platform should provision through
a service-binding-only operation or require a signed, one-use provisioning
credential, and it must not publish the hostname before ownership exists.

Signup, login, handle reservation, verification resend, and recovery endpoints
need server-validated bot protection and rate limits. Validation responses
should not disclose whether an email or credential is registered.

## Credential recovery

Managed credential recovery belongs to the global platform account. Recovering
a platform principal restores its mapped installation memberships; it does not
rename local users or recreate their homes.

The initial recovery contract should include:

- verified email;
- passkeys or another phishing-resistant primary credential;
- at least one independent backup credential or one-time recovery codes;
- hashed, expiring, single-use verification and recovery tokens;
- session revocation after sensitive recovery;
- notifications on credential, email, ownership, and recovery changes; and
- recent-authentication requirements for billing, export, deletion, hostname,
  membership, and ownership changes.

Account recovery and data encryption have an unavoidable product tradeoff.
Current GSV storage is access-controlled but is not encrypted with a key known
only to the user, so the managed service can restore authentication without
losing data. If GSV later introduces user-only encryption, it must deliberately
choose a user-held recovery key, explicit key escrow, or irrecoverability. It
cannot promise both provider-impossible access and provider-assisted recovery.

Authentication implementation should use a mature audited library or provider
rather than extend Kernel `AuthStore` into a global Internet identity system.
An open-source Workers-compatible stack with D1, passkeys, verification,
sessions, and recovery is a strong fit, but it remains a replaceable platform
component behind the principal and login-ticket contracts.

Transactional email is part of the authentication availability path. Delivery,
bounces, suppression, retry behavior, and provider maturity need monitoring and
a documented fallback plan.

## Billing and entitlements

Billing belongs to the managed control plane, not the Kernel. External customer,
checkout, subscription, invoice, webhook, and tax data never becomes agent
runtime configuration.

The installation is the initial subscription unit. A billing account may pay
for multiple installations later, and an installation may contain multiple
local users. Local UIDs, agents, processes, messages, and tool calls are not
appropriate primary subscription identities.

The platform stores billing-provider identifiers and a derived entitlement
projection. The billing provider remains authoritative for payment state.
Webhook processing must:

- verify the signature against the unmodified raw request body;
- deduplicate provider event IDs;
- tolerate retries and out-of-order delivery;
- fetch current provider objects when an event is insufficient or stale; and
- update entitlements idempotently.

Do not directly translate a payment-provider status into immediate data loss.
Use an explicit installation lifecycle such as:

```text
provisioning
  -> trialing
  -> active
  -> past_due
  -> restricted
  -> cancelled
  -> retained
  -> deleting
  -> deleted
```

`past_due` has a grace period. `restricted` can pause schedules, new inference,
and other cost-generating work while preserving authentication, billing repair,
inspection, export, and teardown. Cancellation ends service according to the
paid-through date. Retention and deletion are separate, visible policies.

The Gateway consumes a narrow entitlement decision rather than calling the
billing provider on requests. Kernel background work also receives entitlement
changes so schedules and agents do not continue accruing unbounded cost after
restriction.

Pricing, included inference, bring-your-own-provider behavior, storage
allowances, member limits, and retention duration are product decisions built
on top of this entitlement contract rather than embedded in routing code.

## Standalone correspondence

The managed and standalone paths should differ only outside the installation:

| Concern | Managed | Standalone |
|---|---|---|
| Installation ID | provisioned by platform | generated or configured locally |
| Canonical origin | managed hostname/custom domain | deployment configuration |
| Host resolution | platform directory | fixed installation binding |
| Human login | platform principal mapped to local UID | local password/token |
| Billing | platform entitlement | none |
| Runtime state | Kernel/Process/R2/ripgit | same logical model |

This correspondence is the reason to introduce installation scope now. The
managed product validates the same GSV abstraction that can later be packaged
for an individual open-source deployment instead of creating a second runtime
architecture.

## Migration sequence

### 1. Introduce installation identity

- Define installation identity and trusted routing context.
- Name Kernel Durable Objects by immutable installation ID.
- Store canonical origin and handle as installation metadata.
- Make standalone development use one explicit local installation ID.

### 2. Scope every runtime address

- Require installation ID in Process lookup and parent routing.
- Introduce installation-scoped R2 storage and remove raw binding access from
  installation-local code.
- Scope ripgit repository references and Repository DO names.
- Scope adapter account DO names and Gateway service frames.
- Audit caches, logs, analytics dimensions, OAuth state, media URLs, Git proxy
  paths, and cleanup operations.

### 3. Prove isolation

Create two installations containing deliberately identical local identifiers:

- UID and GID `1000`;
- username `alice` and home `/home/alice`;
- PID chosen identically in a controlled test;
- repository `alice/home`;
- public path `/public/example.txt`; and
- matching adapter-local identifiers where possible.

Tests must prove that neither installation can read, write, list, route to,
authorize, clean up, or receive events from the other's resources. Also prove
that an unknown hostname does not allocate a Kernel.

### 4. Add the managed control plane

- Add global authentication and platform sessions.
- Add installation, hostname, membership, provisioning, and lifecycle tables.
- Add private idempotent Kernel provisioning.
- Add host-only login-ticket exchange.
- Add transactional email, recovery, Turnstile, and rate limits.

### 5. Add billing

- Integrate hosted checkout, subscriptions, a customer portal, and signed
  webhooks.
- Add idempotent entitlement projection and lifecycle transitions.
- Add graceful restriction, export, retention, and deletion flows.
- Run clean-instance end-to-end tests from signup through first agent run,
  payment failure, recovery, export, cancellation, and deletion.

## Validation gates

Managed GSV is not ready for external users until all of these are true:

- arbitrary wildcard hostnames cannot create or claim installations;
- no installation-local code can address unscoped R2, Process, ripgit, or
  adapter state;
- an uninitialized managed Kernel cannot be claimed through public setup;
- installation A cannot use identifiers obtained from installation B;
- background alarms and scheduled work retain their installation identity;
- canonical URLs remain correct without an active browser request;
- billing webhook replay and reordering are harmless;
- payment failure preserves login, billing repair, export, and teardown;
- credential recovery is rate-limited, audited, and session-revoking; and
- complete installation export and deletion operate on an explicit bounded
  resource set.

## Open product decisions

- The initial managed subscription price and included inference allowance.
- Whether model usage is bundled, metered, bring-your-own-provider, or a hybrid.
- Whether the billing provider is a merchant of record or a direct payment and
  tax stack.
- Whether the first release allows invited human members.
- Whether one external adapter account may connect to multiple installations.
- Handle rename and retired-handle reuse policy.
- The standard grace period, retention period, and deletion warning schedule.
- Whether managed recovery is sufficient or a user-held installation recovery
  key is also required.
- Whether the current maturity of Cloudflare Email Sending is sufficient for
  the recovery path or requires a secondary provider.
