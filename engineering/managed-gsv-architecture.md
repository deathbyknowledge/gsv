# Managed GSV Product and Architecture Specification

Status: accepted implementation specification. This document is the source of
truth for the initial managed GSV service. The current implementation remains a
single-installation deployment until the migration and release gates described
here are complete.

Changes to the managed product contract, trust boundaries, isolation model, or
launch scope must update this document in the same batch. Provider names,
prices, limits, and credentials are runtime configuration rather than durable
architecture.

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

## Initial product contract

The managed product creates **your GSV**: one durable personal intelligence at
`<handle>.gsv.space`, reachable from the web and the managed GSV Telegram bot.
The user does not deploy Workers, create storage, configure a model provider,
create a Telegram bot, or understand Durable Objects during onboarding.

The initial paid plan includes:

- one managed GSV installation;
- the web desktop at its canonical `gsv.space` hostname;
- managed storage, processes, repositories, schedules, upgrades, and recovery;
- GSV Intelligence for ordinary text and tool-using agent work, subject to a
  generous internal fair-use budget;
- one linked Telegram identity through the shared managed GSV bot; and
- an advanced bring-your-own-model-provider path that does not reduce the base
  subscription price.

The launch price is USD 20 per month for founding customers. The intended list
price is USD 29 per month after the founding cohort. Price selection is billing
configuration, but the subscription unit and included-service semantics are
part of this contract. There is no permanent free hosted tier. Invite-only,
operator-granted, or payment-method-backed trials may use the same entitlement
state machine without creating a second product tier.

Inference is presented as **GSV Intelligence**, not as token inventory or an
upstream-provider resale product. Most users should never see credits, API
keys, cache pricing, or provider names during setup. Before restricting normal
work, the product warns the user and offers an add-on or BYOK route. It must not
claim unlimited use.

Managed Telegram is included at launch. WhatsApp is not a launch dependency or
advertised entitlement because its current general-purpose AI policy and
region-specific regulatory exceptions are not a reliable global product
contract. Standalone and user-owned adapters continue to exist independently.

The first release provisions one human owner. The data model retains multiple
members and local users, but invitations and multi-member management are
deferred until the single-owner flow has passed the release gates. Installation
handles cannot be renamed in the first release. Custom domains, multiple active
GSVs per managed Telegram identity, Telegram groups, and customer-supplied
Worker code are also deferred.

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

The production Worker identities are `gsv-accounts`,
`gsv-managed-gateway`, `gsv-inference`, `gsv-managed-telegram`, and
`gsv-managed-ripgit`. Only the account route, the Telegram webhook route, and
the wildcard Gateway route are public. Exact `accounts.gsv.space/*` and
`telegram.gsv.space/*` routes take precedence over `*.gsv.space/*`; inference
and ripgit disable all public development and preview URLs. The checked configs,
clean-account service-binding bootstrap, state provisioning order, trigger
activation, and rollback procedure live in
`engineering/managed-gsv-deployment.md`.

These are ordinary Workers. Keeping the managed control plane separate prevents
billing-provider secrets, global account records, recovery authority, and
provisioning credentials from entering the agent runtime environment. The
Gateway should receive only narrow operations such as hostname resolution,
entitlement lookup, and login-ticket verification.

The complete initial service graph is:

```text
Browser
  -> accounts.gsv.space control plane
  -> <handle>.gsv.space Gateway

Telegram
  -> managed Telegram adapter
  -> installation-scoped Gateway entrypoint

Installation Kernel / Process
  -> managed inference broker
  -> ripgit
  -> adapter delivery

Billing provider and email provider
  -> control plane webhooks / delivery APIs
```

No public caller selects an installation ID. The account service resolves it
from an authenticated membership, the Gateway resolves it from an accepted
hostname, the Telegram adapter resolves it from an active peer link, and
background work retains it in durable state.

## Managed control-plane data model

The control plane uses a relational store with database-enforced uniqueness for
global identity and directory state. Per-principal or per-operation Durable
Objects may coordinate races and retries, but a single global Durable Object
must not become the request path for all installations.

The initial logical schema contains:

```text
principals
  id, primary_email, email_verified_at, state, created_at

credentials
  id, principal_id, kind, public_data, secret_hash, created_at, revoked_at

sessions
  id_hash, principal_id, created_at, expires_at, recent_auth_at, revoked_at

installations
  id, owner_principal_id, handle, canonical_origin, state,
  provision_version, created_at, activated_at, retained_until, deleted_at

hostnames
  normalized_hostname, installation_id, kind, state, created_at, retired_at

memberships
  installation_id, principal_id, local_uid, role, state, created_at

provisioning_operations
  operation_id, installation_id, kind, state, attempt, last_error, updated_at

billing_accounts
  id, principal_id, provider, provider_customer_id, created_at

subscriptions
  id, billing_account_id, installation_id, provider_subscription_id,
  price_key, state, paid_through, updated_at

billing_events
  provider, provider_event_id, received_at, processed_at, outcome

entitlements
  installation_id, state, plan_key, inference_budget_microunits,
  inference_period_starts_at, inference_period_ends_at,
  storage_limit_bytes, effective_at, version

login_handoffs
  token_hash, principal_id, installation_id, local_uid, expires_at, used_at

verification_and_recovery_tokens
  token_hash, principal_id, purpose, expires_at, used_at

audit_events
  id, principal_id, installation_id, action, outcome, created_at, metadata_json
```

Raw session, verification, recovery, login-handoff, and API credentials are
never stored. Token lookup uses a non-secret prefix or identifier plus a hash;
verification uses constant-time comparison. Audit metadata is allowlisted and
must not contain passwords, tokens, prompts, messages, private files, model
arguments, or billing instrument data.

The first implementation keeps provider-specific billing payloads outside the
Kernel and stores only the minimum normalized identifiers needed to reconcile
provider state. Full webhook bodies may be retained only in a separately
access-controlled operational store with an explicit retention policy.

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

## Installation export

The managed account service exposes an owner-only installation export. Starting
an export requires an authenticated platform session with recent passkey
verification, exact account-origin validation, and a rate-limit decision. It is
available while an installation is active, payment-restricted, cancelled,
retained, or in its recoverable deletion window. Billing state must not gate
data portability. Export is rejected after irreversible teardown starts.

The account service records a content-free `installation.export_requested`
audit event, then asks the trusted Gateway service binding to address the Kernel
by `installationId`. The browser never supplies a hostname, Kernel name,
repository identity, R2 prefix, or Process object address to the export RPC.

Version 1 is an uncompressed, streaming USTAR/PAX archive. It contains:

- a versioned manifest, safety notice, and final completion record;
- the Kernel's application SQLite schema, secondary schema objects, sequence
  state, and rows as a catalog plus bounded, ordered JSON pages;
- each registered Process record and its corresponding complete SQLite catalog
  and pages;
- a self-contained standard Git bundle for every installation repository;
- every installation-logical R2 object as exact bytes plus its R2 metadata; and
- the immutable installation identity needed to interpret those resources.

The archive intentionally includes local credentials, provider configuration,
private files, histories, and other secrets owned by the installation. It uses
`Cache-Control: no-store`, attachment disposition, MIME sniffing protection,
and a sandbox content policy, but the downloaded file must be handled like a
password-manager or full-device backup. Global platform-account, billing,
abuse-control, and provider-webhook records are not installation runtime state
and are not included.

Archive paths encode untrusted object and process identifiers rather than
placing them into paths verbatim. Repository streams require an authenticated
internal actor. SQL export captures a table schema, row-count, and rowid
high-water mark before paging and fails if that bounded row set cannot be read
as declared. R2 is accessed only through the installation-scoped bucket. Git
bundles are generated inside the installation-scoped ripgit object.

The format provides resource-level capture rather than a globally atomic
snapshot across independent Durable Objects, R2, and ripgit. Resources are
serialized in deterministic order where the backing service supports it. A
successful archive ends with `completion.json`, whose counts and byte totals
describe the resources actually serialized. Its absence means the stream was
cancelled, interrupted, or failed and the archive must be treated as
incomplete. Browser cancellation propagates to the active entry body and
unread sources so a disconnected download does not continue unbounded work.

The export contract is versioned independently of an eventual importer.
Automated restore and migration tooling must validate the manifest and require
the completion record; implementing and exercising that restore path remains a
Phase 9 release gate.

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

Production signup remains closed until `gsv.space` is activated as an Email
Sending domain for `noreply@gsv.space` and the account Worker has a
`TURNSTILE_SECRET` Worker secret for a hostname-restricted production widget.
The matching public site key is exposed to the account UI through the narrow
`/api/public/config` response and is configured as
`GSV_TURNSTILE_SITE_KEY`; the secret stays only in the account Worker. The
production site key and secret must belong to the same widget, whose hostname
allowlist contains only the intended account host. Deterministic Worker tests
use the documented Cloudflare test site key and an in-process verifier, and no
billing-provider credential is needed before the concrete billing adapter in
Phase 7.

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

A verified webhook is a wake-up signal, not the subscription snapshot used for
authorization. The account service records only the provider/event identifiers,
event timestamp, subject identifier, raw-body hash, processing lease, outcome,
and a content-free failure code. It then fetches the provider's current
subscription object and reconciles that normalized snapshot. Reordered event
notifications therefore converge on current provider state. An exact replay is
deduplicated; a failed or abandoned processing lease can safely retry. Raw
provider payloads and signatures are not retained.

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

### Commercial and lifecycle defaults

The provider integration is replaceable. Kernel and Gateway code consume
provider-neutral checkout, portal, subscription, and entitlement contracts.
Tests use a deterministic fake provider. A real adapter receives credentials
only through Worker secrets and receives price identifiers through non-secret
environment configuration. Production credentials are never required for local
development, committed to the repository, or exposed to an installation.

The initial lifecycle policy is:

- provisioning begins only after an authoritative paid or operator-granted
  entitlement exists;
- a failed renewal enters `past_due` with a seven-day grace period;
- after grace, `restricted` pauses new inference, schedules, and other
  cost-generating work while preserving login, billing repair, inspection,
  export, and deletion;
- cancellation remains active through the paid-through time and then enters a
  30-day retained state;
- retention warnings are sent when retention begins, seven days before
  deletion, and one day before deletion; and
- explicit user deletion requires recent authentication and confirmation,
  disables new work immediately, and uses a seven-day recoverable window before
  irreversible deletion unless law or an incident-response policy requires a
  different hold; and
- explicit deletion creates an independently retryable immediate subscription
  cancellation obligation. Recovery cancels that obligation if the provider
  call has not started, but it never attempts to reactivate a subscription the
  provider already cancelled; paid-through access and a new checkout remain the
  recovery path.

These durations are configuration surfaced in user-visible policy. Changing
them must not change lifecycle meanings or bypass notifications and export.
The subscription record and effective entitlement deliberately differ during a
paid-through cancellation: the subscription is `cancelled`, while its
entitlement remains `active` until the paid-through timestamp. The scheduled
lifecycle reconciler then projects `retained` without waiting for another
provider event. Likewise, an unchanged `past_due` snapshot projects
`restricted` when its original grace deadline passes.

### Stripe launch adapter and merchant mode

Stripe is the first concrete, replaceable billing adapter. GSV uses
[hosted Checkout](https://docs.stripe.com/api/checkout/sessions/create) for a
single recurring installation subscription and creates a short-lived
[customer portal session](https://docs.stripe.com/api/customer_portal/sessions)
on demand for payment repair, invoices, cancellation, and payment-method
management. GSV does not collect or persist payment-instrument data, hosted
session URLs, raw webhook bodies, or signatures. It persists only stable
provider identifiers, content-free reconciliation state, and the derived
entitlement projection.

The adapter verifies Stripe's signature over the untouched request bytes as
required by Stripe's [webhook signature guidance](https://docs.stripe.com/webhooks/signature),
then treats the event only as a wake-up signal and refetches the current
subscription. A checkout success redirect is presentation state, not payment
authority. Activation and restoration wait for the verified webhook-derived
entitlement before allowing cost-generating work.

`GSV_STRIPE_MERCHANT_MODE` has no implicit production default. It must be one
of:

- `managed_payments`: request [Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments/how-it-works),
  where Stripe describes Stripe/Link as merchant of record. This is the
  preferred launch candidate if GSV is admitted to the current preview and its
  commercial terms, support allocation, product eligibility, country coverage,
  refund handling, data processing, and termination path pass review.
- `direct`: GSV is merchant of record. Checkout enables automatic tax,
  billing-address collection, customer address updates, and tax-ID collection,
  but Stripe Tax calculation does not remove GSV's responsibility for tax
  registrations, filing, remittance, refunds, disputes, and customer billing
  support.

This switch exists to avoid coupling entitlement semantics to the merchant
arrangement. It is not permission to enable Managed Payments without Stripe
eligibility or to launch direct mode without tax and legal ownership.

Production billing remains fail-closed until all of the following exist:

- `STRIPE_SECRET_KEY` as an account-Worker secret;
- `STRIPE_WEBHOOK_SECRET` as an account-Worker secret for the exact
  `/api/billing/webhooks/stripe` endpoint;
- `GSV_STRIPE_FOUNDING_PRICE_ID` as non-secret configuration for a recurring
  USD 20 monthly Price matching the public founding offer;
- an explicit `GSV_STRIPE_MERCHANT_MODE` selection;
- a configured customer portal;
- webhook delivery for checkout completion and customer subscription lifecycle
  events.

Do not enable Stripe Checkout's customer-wide **limit customers to one
subscription** setting: one principal may own several GSVs, each with its own
subscription under the same provider customer. GSV instead serializes Checkout
per installation in D1, expires abandoned operations only after the provider
session can no longer complete, and rejects a second subscription for an
installation during reconciliation.

Test-mode values are needed only for a live Stripe smoke test. Local tests use
the signed deterministic fake provider and Stripe SDK test fixtures, so no
developer or production credential is required.

## Managed inference

The managed inference broker is a separate Worker reached through a service
binding. Installation Kernels never receive the platform-funded upstream API
key. The broker accepts only trusted internal calls carrying installation and
local execution identity derived by the Gateway or Process runtime.

```text
Process
  -> managed inference service binding
  -> installation budget coordinator
  -> capability-aware provider router
  -> upstream inference API
```

The stable product model is `gsv/default`. DeepSeek V4 Flash 0731 is the initial
default candidate for text, reasoning, and tool-using work because its economics
make bundled inference viable. The product contract does not expose its API
alias as a durable identifier. Model and serving provider are separate choices:
the router may use the official DeepSeek API, a contractually suitable host of
the open weights, or a tested fallback without changing GSV configuration.

Candidate evidence recorded on 2026-08-04 comes from DeepSeek's own release
materials and is not yet GSV validation. The vendor reports 82.7 on Terminal
Bench 2.1, 54.2 on NL2Repo, 76.7 on Cybergym, 54.4 on DeepSWE, 70.3 on
Toolathlon Verified, and 25.2 on Agents' Last Exam for V4 Flash 0731. Its
[official API price](https://api-docs.deepseek.com/quick_start/pricing?article_id=article_1779470751466_8)
is USD 0.0028 per million cache-hit input tokens, USD 0.14 per million
cache-miss input tokens, and USD 0.28 per million output tokens. The versioned
broker price book records those rates in integer microdollars; production
promotion still depends on GSV's own task evaluation, observed latency and
reliability, and the privacy and contractual gate below. The release evidence
is recorded in DeepSeek's [official changelog](https://api-docs.deepseek.com/updates/)
and [official model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731).

The default may not process real customer data until the selected host provides
acceptable written terms for API data use, training, retention, deletion, data
location, subprocessors, security, and applicable data-processing agreements.
Synthetic evaluation may proceed before that gate. A provider-specific model
revision must pass GSV evaluations before promotion; an unversioned upstream
alias is never promoted blindly.

Promotion is enforced by a source-controlled release allowlist in the inference
Worker. A provider name, production API key, and environment-variable change
cannot enable customer prompts while that allowlist is blocked. Approval must
record immutable content-free evidence report digests for the selected default
and at least one fallback, plus affirmative privacy/data-processing, security,
capacity/reliability, and brand/acceptable-use reviews.

The versioned `gsv-managed-text-v1` evaluation suite covers GSV's fixed tool
surface, concurrent reads, durable shell continuation, CodeMode composition,
instruction precedence, destructive-action restraint, tool-result grounding,
and long-context retrieval. It uses only synthetic fixtures through the real
provider adapter. Its report includes stable task and assertion IDs, aggregate
scores, reported token usage and cost, and latency, but never persists fixture
prompts or model output. A DeepSeek credential is needed only to execute this
evaluation against the live candidate; it is not needed to build or test the
gate and it never belongs in the Gateway.

The broker owns:

- upstream credentials, prepaid balance monitoring, health, and failover;
- a versioned price book including cache-hit, cache-miss, output, and scheduled
  peak multipliers;
- atomic per-installation monthly, daily, and concurrent-use limits;
- provider-attempt idempotency and usage settlement;
- model capability routing for text, images, audio, and other media;
- opaque upstream user isolation derived from installation ID and run-as UID;
- allowed-content and abuse controls required by upstream contracts; and
- content-free telemetry for latency, outcome, token class, cost, cache rate,
  provider, and model revision.

Before an upstream request, the budget coordinator reserves a conservative
maximum cost using uncached input and the GSV-controlled maximum output. After
the response it atomically settles actual cache-hit input, cache-miss input, and
output usage and releases the remainder. Failure and ambiguous-provider states
have explicit settlement rules; retrying with another provider uses the same
logical request ID and a distinct attempt ID.

The founding plan initially targets approximately USD 5 of upstream inference
cost per installation per billing month as an internal safety budget. This is a
configurable cost-control value, not a user-facing token balance or promise of a
fixed token count. Cohort telemetry determines the production allowance before
the list-price launch. The broker continues to enforce smaller rolling and
concurrency limits even when monthly budget remains.

The account service may read the current installation budget period through a
narrow internal inference RPC only after authenticating the owning principal.
It converts content-free microunit counters into a bounded percentage and the
plain-language states `normal`, `approaching`, `critical`, or `exhausted`.
Browser APIs never expose provider names, token counts, price-book entries, or
raw upstream cost. This read is advisory: inference unavailability suppresses
the warning rather than blocking login, billing repair, export, recovery, or
deletion.

DeepSeek V4 Flash is text-only for product purposes. GSV routes image, audio,
speech, and other unsupported input to an explicitly capable model or reports a
clear unsupported capability. It must not silently replace private media with
placeholders. The runtime retains its current conservative output limit rather
than exposing the upstream model's maximum.

BYOK resolves through the same GSV inference interface but uses an
installation-owned provider configuration and usage policy. It must not allow a
managed installation to extract the platform key, bypass entitlement checks for
platform-funded resources, or make provider-specific behavior part of the
agent-facing tool contract.

## Managed Telegram

The managed service owns one GSV-branded Telegram bot and one adapter Worker.
Customers do not create bot accounts or handle webhook credentials. The adapter
is a replaceable delivery surface: Telegram loss or suspension does not remove
the installation, its web login, processes, or data.

Managed mode routes before calling a Kernel:

```text
Telegram webhook
  -> peer-scoped adapter Durable Object
  -> active Telegram actor -> installation route
  -> installation-scoped Gateway service RPC
  -> Kernel-local actor -> UID identity link
  -> normal adapter ingress and Process routing
```

The Durable Object coordination atom is a Telegram peer/direct conversation,
not the global bot account. It owns pending link state, the exclusive active
installation route, ingress retry records, and outbound idempotency for that
conversation. Bot credentials and webhook verification remain Worker-owned.
A small bot-account control object may own lifecycle configuration but must not
serialize all customer messages.

The first connection flow is account linking, not authentication by handle:

1. An unlinked direct message creates or reuses a short-lived one-time claim
   bound to the Telegram bot account, actor, and surface.
2. The bot replies with a `Connect your GSV` button on
   `accounts.gsv.space`; it never requests a password, recovery code, or model
   credential in Telegram.
3. The platform authenticates the principal, requires recent authentication
   when appropriate, and presents only installations in that principal's
   membership list.
4. The user confirms the Telegram identity and target GSV. A single membership
   is preselected; multiple memberships require an explicit choice.
5. The platform idempotently creates the Kernel-local identity link through a
   private operation and marks the global route active only after Kernel
   acknowledgement.
6. The bot confirms the canonical GSV hostname. Pre-link messages are not sent
   to a model and are not replayed automatically.

The button puts the bearer claim in the account-page URL fragment, so it is not
sent in the initial HTTP request or referrer. The page submits it in the body of
an exact-origin, authenticated `POST`. The control plane persists only a
domain-separated claim-token hash. Its durable operation stages are
`created`, `route_suspended`, `old_kernel_unlinked`, `new_kernel_linked`, and
`complete`; retrying any stage reuses the same external operation IDs. Once an
operation owns a suspended claim, a browser retry that resubmits the same bearer
can resume after public claim expiry without reopening the route.

The account page copies the fragment bearer into memory and removes the entire
fragment with `history.replaceState` before rendering or loading third-party
code. A fresh browser performs Turnstile-protected discoverable-passkey login on
the account origin; confirmation requires a recent passkey ceremony. The page
shows the Telegram display identity, signed-in account, canonical hostnames,
and membership roles, but no local UID, actor ID, installation ID, or raw route
state. One installation is preselected; several require an explicit selection.
The page keeps one idempotency key for in-page retries and never puts the claim
in a request URL or browser storage.

The global route chooses an installation; the Kernel identity link chooses and
authorizes the local UID. Both mappings remain because they protect different
boundaries. An actor may have only one active managed GSV route initially.
Relinking first disables the old global route, removes the old Kernel link, and
then activates the new route through a resumable state machine.

Every outbound managed-adapter call carries trusted installation context. The
adapter verifies that the destination peer is actively linked to that same
installation before contacting Telegram. This prevents an installation from
sending to another installation's peer even if it learns a provider identifier.
Installation users cannot connect, disconnect, or replace the platform-owned
bot account.

The launch supports direct messages only. Groups, channels, multiple active
GSVs with `/switch`, custom managed bots, and Telegram-based account recovery
are deferred. Standalone installations retain the existing local challenge
flow and user-owned bot token. A managed Telegram link grants only the
capabilities of its mapped local UID and is not a global account credential.
The account service publishes the configured public bot username through its
otherwise secret-free public configuration so the dashboard can link directly
to the managed bot. The token remains exclusively in the Telegram Worker, and
the bot username is an environment-owned launch input rather than a hardcoded
product identifier.

## Private service contracts

Cross-Worker APIs are narrow typed RPC interfaces. They accept domain values,
not arbitrary protocol frames from public callers. All mutating operations
carry an idempotency or operation ID generated by the owning service.

The control plane exposes to the Gateway:

```ts
interface InstallationDirectoryService {
  resolveHostname(hostname: string): Promise<
    | {
        found: true;
        installationId: string;
        handle: string;
        canonicalOrigin: string;
        state: string;
      }
    | { found: false }
  >;
  verifyLoginHandoff(token: string, hostname: string): Promise<
    | { ok: true; installationId: string; principalId: string; localUid: number }
    | { ok: false }
  >;
}

interface ManagedEntitlementReader {
  getEntitlement(installationId: string): Promise<InstallationEntitlement>;
}
```

The Gateway exposes to trusted platform services:

```ts
interface ManagedGatewayService {
  provisionInstallation(input: ProvisionInstallationInput): Promise<ProvisionResult>;
  linkManagedActor(input: LinkManagedActorInput): Promise<LinkManagedActorResult>;
  unlinkManagedActor(input: UnlinkManagedActorInput): Promise<UnlinkManagedActorResult>;
  deliverAdapterInbound(
    installationId: string,
    input: AdapterInboundInput,
  ): Promise<AdapterInboundResult>;
}
```

The inference broker exposes:

```ts
interface ManagedInferenceService {
  run(input: ManagedInferenceRequest): Promise<ManagedInferenceResponse>;
  abort(input: ManagedInferenceAbort): Promise<{ aborted: boolean }>;
}

interface ManagedInferenceUsageReader {
  getManagedInferenceBudgetUsage(
    installationId: string,
  ): Promise<ManagedInferenceBudgetUsage | null>;
}
```

Concrete request types must carry the smallest required identity and operation
metadata. They do not carry global sessions, billing-provider payloads, raw
email addresses, or user-selected installation IDs. Public HTTP handlers first
derive trusted context and then call these interfaces.

## Security and operational policy

The managed control plane, Gateway, inference broker, Telegram adapter, and
ripgit are separate security principals with separate secrets and the minimum
service bindings required for their direction of calls. No service receives all
of authentication recovery authority, billing credentials, model credentials,
and installation data bindings.

Public account endpoints use origin checks, CSRF protection where cookies
authenticate mutations, server-side validation, rate limits, and bot protection.
Sensitive operations require recent authentication. Errors for login,
verification, and recovery do not reveal whether an account exists.

Logs and analytics use an explicit allowlist. Allowed dimensions include opaque
principal and installation IDs, operation ID, service, route class, state
transition, duration, byte/token counts, cost microunits, status, and normalized
error category. Disallowed data includes raw credentials, cookies, authorization
headers, Telegram claim URLs, prompts, messages, tool arguments, private paths,
file contents, media, provider response bodies, and payment instruments.

Every external dependency has health and exhaustion monitoring appropriate to
its role: email delivery and suppression, billing webhook lag, model-provider
balance and rate limits, Telegram webhook backlog, D1 errors, R2 failures,
Durable Object alarm retries, and installation provisioning age. Alerts operate
on metadata and outcomes rather than customer content.

The platform maintains an operator path for inspecting and repairing
provisioning, entitlement, adapter-link, and deletion state without granting
operators a general interactive user session inside an installation. Any
exceptional access to installation content requires a separate explicit policy,
strong audit, and user-visible disclosure; it is not implied by this spec.

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

## Implementation program

Each phase is a separately reviewable and committed batch. A later phase may
add interfaces or test doubles early, but it must not depend on an unproven
isolation boundary. Protected prompt and seeded context content are not changed
by this program.

Current implementation status as of 2026-08-05: phases 0 through 4 are complete
for the existing runtime on the managed-service branch. Kernel, Process, R2,
ripgit, and user-owned adapter state now share one installation boundary with
explicit standalone compatibility. The account-service
D1 schema, atomic handle reservation, active-host directory, resumable private
Kernel provisioning, managed public-setup rejection, and one-time host-session
handoff boundary are implemented. The account service now also implements
short bootstrap sessions, host-only platform sessions, discoverable passkeys,
hashed one-time recovery codes, complete session and credential revocation
during recovery, recent-auth checks, transactional verification and security
notification email, atomic handoff auditing, exact-origin mutation checks, D1
rate limits, and fail-closed Turnstile verification. Authenticated public handle
reservation is idempotent, expired reservations are reclaimed, and private
Kernel provisioning now requires an effective provider-neutral entitlement.
The clean account-to-Kernel integration flow covers reservation, entitlement,
provisioning, hostname activation, entry, logout, and re-entry against a real
Kernel. Production activation of email and Turnstile remains an external release
gate. Phase 5 is in progress: the provider-neutral entitlement period contract,
separate inference Worker, DeepSeek V4 Flash 0731 price book and adapter,
SQLite-backed per-installation budget coordinator, conservative admission,
attempt settlement, opaque upstream user isolation, synthetic provider, and
abort path are implemented and deterministically tested. Managed provisioning
selects `gsv/default`; Kernel and Process routing derive trusted installation
and actor identity, reuse a stable logical ID across provider retries, preserve
BYOK, reject unsupported media, and propagate cancellation to the broker. A
clean four-Worker integration flow proves a failed first attempt can settle and
retry without changing logical request identity. The real provider is disabled
by default and is additionally blocked by a source-controlled promotion gate.
The repeatable content-free GSV task evaluation harness is implemented; a live
candidate run, a selected and evaluated fallback, and the provider privacy and
contractual approvals remain before customer prompts can be enabled. Phase 6
implementation is also complete behind the production launch gate. The separate
managed Telegram Worker owns peer-scoped Durable Objects, signed one-time
claims, exclusive installation routes, inbound retry state, and outbound
delivery authorization. The account service owns a recent-passkey, resumable
relink operation; the Gateway owns Kernel-local identity links; and a dedicated
account page consumes claim fragments without persisting the bearer. A clean
five-Worker integration flow proves that an unlinked DM cannot allocate
inference, account confirmation links the real Kernel and peer, a foreign
installation cannot send to that peer, and a linked DM reaches only the selected
installation through the managed inference broker. Standalone Telegram remains
unchanged. The production bot credentials, public bot username, webhook
registration, account Turnstile widget, and overall Phases 5 through 9 launch
gates remain external or incomplete, so managed production hosting remains
disabled.

Phase 7 is in progress. Its provider-neutral subscription schema, event lease
and deduplication store, current-snapshot reconciler, lifecycle deadline
advancer, entitlement projection, plan catalog, and signed deterministic fake
provider are implemented. Tests cover exact replay, out-of-order notification,
failed-event resumption, invalid signatures, seven-day grace semantics, and
paid-through cancellation followed by retention. The first concrete adapter now
uses Stripe's Worker-compatible SDK for hosted Checkout, hosted customer-portal
sessions, exact-raw-body webhook verification, and authoritative subscription
refetch. Checkout, portal, billing overview, production webhook, and scheduled
lifecycle routes are wired through the account service, and the dedicated
account UI never treats a browser return as payment proof. The adapter can run
in either direct-merchant or Stripe Managed Payments mode without changing GSV's
provider-neutral contracts. No merchant credential is committed or wired, and
the explicit merchant mode remains a production release choice. Recoverable
explicit deletion, retention expiry, cross-service suspension and recovery,
exact resource inventory, and bounded teardown across Process, ripgit, R2,
inference, Telegram, Kernel, and Account state are implemented and covered by a
real multi-Worker lifecycle flow. A leased D1 notification outbox now delivers
payment, restriction, retention, recovery, and deletion notices with bounded
retry; retention teardown is gated on attempted start, seven-day, and one-day
warnings. Production activation of the sending domain remains an external
release gate. Explicit deletion also records provider cancellation atomically,
retries it independently of data teardown, and prevents late provider events
from restoring entitlement to deleting or deleted installations. The
recent-passkey, owner-only installation export now streams Kernel and Process
SQL, exact R2 objects and metadata, and self-contained Git bundles through the
Account and Gateway service-binding chain. A real multi-Worker flow proves it
remains available after payment restriction and emits a final completion
record. The distinct managed Worker identities, public and internal routes,
least-authority service graph, secret ownership, clean-account binding
bootstrap, state provisioning order, dry-run bundle validation, activation
order, and rollback procedure are now executable in the production topology.
Phase 8 implementation is now complete behind the external launch gates. The
account Worker serves one credential-safe browser shell for signup, email
verification, passkey enrollment and recovery, handle choice, Stripe Checkout,
signed-entitlement polling, provisioning progress, and one-use host entry. The
account dashboard presents the launch-scope single GSV, billing repair, a
configured managed Telegram bot, provider-neutral GSV Intelligence warnings,
complete streaming export, recoverable deletion, and recovery. Cancelled
Checkout resumes the same idempotent provider operation, and a browser success
return never grants service. Sensitive operations require a recent passkey;
billing and inference presentation failures do not remove account, export, or
deletion controls. A live nontechnical-user exit run still depends on the
production email, Turnstile, Stripe, Telegram, and promoted-model gates.

Phase 9 is in progress. A clean two-installation hostile test now deliberately
reuses local usernames, UID 1000, process labels, and logical filesystem paths,
then proves account membership, host sessions, R2-backed filesystem data, and
Process Durable Objects remain isolated. Separate integration tests retain
installation identity across matching adapter delivery identifiers and
inference request identifiers. Automated restore validation, load and provider
failure exercises, production dashboards and alerts, and cohort rollout remain
incomplete.

### Phase 0: executable specification

- Record the product, security, business, inference, Telegram, migration, and
  release decisions in this document.
- Maintain a decision log for deliberate contract changes.
- Keep real-provider credentials out of development and tests.

Exit: no remaining product ambiguity changes the installation boundary or the
order of implementation.

### Phase 1: installation identity and Kernel routing

- Define validated `InstallationId`, `InstallationIdentity`, and trusted routing
  context types.
- Replace ambient Kernel singleton lookup with explicit installation-scoped
  helpers.
- Route standalone requests to one configured installation while preserving the
  explicitly supported legacy standalone Kernel object.
- Add the directory service contract and managed hostname resolution without
  allowing arbitrary hosts to allocate Durable Objects.
- Persist and assert installation identity in the Kernel.
- Derive canonical URLs from persisted installation identity, not the current
  request.

Exit: two Kernel objects can run in one deployment, an unknown managed hostname
returns `404` without allocating one, and standalone upgrade tests retain access
to the legacy Kernel.

### Phase 2: Process and R2 isolation

- Require installation identity in every Kernel-to-Process and
  Process-to-Kernel call.
- Encode Process Durable Object names from installation ID and public PID with a
  collision-free internal format.
- Persist the parent installation identity in each Process and reject mismatch.
- Introduce an installation-scoped R2 interface covering reads, writes, lists,
  deletes, multipart operations, copies, media, archives, and cleanup.
- Prevent installation-local code from retaining the raw shared R2 binding.
- Preserve an explicit standalone compatibility projection for existing
  unprefixed Process and R2 state until a documented migration retires it.

Exit: identical UID, PID, filesystem path, media ID, and archive identifiers in
two installations cannot collide, enumerate, delete, or receive each other's
state.

### Phase 3: ripgit and adapter isolation

- Add installation identity to internal repository references, Repository
  Durable Object names, Git proxy requests, imports, and cleanup.
- Carry trusted installation identity through adapter service RPCs.
- Scope user-owned adapter account Durable Objects by installation.
- Audit OAuth state, public media routes, caches, telemetry dimensions, alarms,
  and scheduled work for ambient or unscoped identity.

Exit: installations containing identical repository and adapter identifiers
remain isolated in both directions, including retries and alarms. A future
global managed adapter must additionally pass the peer-ownership gate in Phase
6 before launch.

### Phase 4: managed control plane and provisioning

- Add the account-service Worker and relational schema with migrations.
- Implement email verification, passkeys or an equivalently phishing-resistant
  primary credential, sessions, recovery codes, session revocation, and recent
  authentication.
- Implement atomic handle reservation and the hostname directory.
- Implement membership and host-only single-use login handoffs.
- Add private idempotent Kernel provisioning; reject public setup in managed
  mode.
- Add bot protection, rate limits, transactional email, audit events, and
  resumable provisioning operations.

Exit: a clean principal can provision, enter, leave, recover, and re-enter one
GSV without a second local password, while a random wildcard hostname and an
unauthorized principal cannot create or claim a Kernel.

### Phase 5: managed inference

- Add the provider-neutral inference Worker, budget coordinator, price book,
  reservation and settlement ledger, and abort path.
- Route `gsv/default` through the broker while retaining BYOK.
- Add capability routing and a non-DeepSeek media path or explicit unsupported
  response.
- Add synthetic provider adapters and deterministic accounting tests.
- Maintain the versioned GSV task evaluation and source-controlled production
  promotion gate.
- Run that evaluation against the selected DeepSeek V4 Flash 0731 host and at
  least one fallback, then record only immutable content-free report digests.
- Complete the provider privacy, security, capacity, brand, and data-processing
  release gate before customer prompts are enabled.

Exit: retries cannot double-charge, installations cannot spend one another's
budget, restriction stops new funded inference, cancellation reaches the active
upstream call owner, and model promotion is backed by GSV evaluation results.

### Phase 6: managed Telegram

- Split global bot lifecycle from peer/direct-message coordination.
- Add short-lived one-time peer claims and the account-service confirmation
  page.
- Add private idempotent Kernel actor linking and resumable unlink/relink.
- Route active peers to installation-scoped Gateway RPC and preserve existing
  Kernel authorization and Process routing.
- Enforce installation ownership again on every outbound delivery.
- Make the managed bot read-only in installation adapter administration.

Exit: an unlinked message never reaches a model, a linked DM reaches only its
selected installation and UID, cross-install outbound delivery is rejected,
and standalone bot linking remains functional.

### Phase 7: billing and entitlements

- Implement the provider-neutral billing contract and fake-provider test suite.
- Add one selected hosted-checkout and customer-portal adapter.
- Verify signed raw-body webhooks, deduplicate events, reconcile out-of-order
  state, and project entitlements.
- Apply lifecycle restrictions to new inference, schedules, and other metered
  work without blocking login, repair, export, or deletion.
- Implement notifications, retention, export, and bounded deletion.

Exit: checkout and webhook replay are idempotent, no browser redirect grants
service, payment failure follows the specified grace policy, and deletion can
enumerate and complete every installation-owned resource. A restricted owner
can download a complete, explicitly versioned installation archive without
billing-provider availability.

### Phase 8: managed product surfaces

- Replace deployment setup with account signup, handle choice, checkout,
  provisioning progress, and automatic entry into the GSV.
- Present GSV Intelligence as the default without token or provider setup.
- Add account, subscription, usage-warning, export, deletion, recovery, and
  Telegram-link surfaces.
- Keep operational and advanced details available without making them the first
  experience.
- Ensure billing and account outages never prevent local Process cancellation,
  inspection, or safe teardown where entitlement policy permits it.

Exit: a new non-technical user can pay, create a named GSV, run an agent, link
Telegram, recover their account, and understand restriction or deletion states
without CLI or Cloudflare knowledge.

### Phase 9: clean-instance E2E and rollout

- Exercise two-installation hostile-isolation tests using deliberately matching
  local identifiers.
- Exercise signup, payment, provisioning, login handoff, first agent run,
  inference accounting, Telegram linking, payment failure, recovery, export,
  cancellation, retention, and deletion from a clean environment.
- Add load and failure tests for directory lookup, hot Telegram peers, inference
  budgets, webhook bursts, alarms, and provider outages.
- Add dashboards, alerts, runbooks, backup/restore validation, and a deployment
  rollback procedure.
- Launch to an internal installation, then a small founding cohort, before
  opening general signup.

Exit: all validation gates below pass in production-like infrastructure and the
founding cohort has an operator-supported rollback and export path.

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

Additional release gates are:

- platform-funded model credentials never enter Kernel config, Process context,
  logs, or user-visible APIs;
- the selected default inference host has passed the documented privacy and
  data-processing review;
- an unlinked Telegram update cannot create a Process or consume inference;
- an installation cannot administer the shared managed Telegram bot;
- billing and inference provider outages degrade to explicit inspectable state
  rather than corrupting entitlement or usage ledgers;
- production secrets exist only in the service that owns them and can be
  rotated without migrating installation data; and
- standalone installation, local authentication, BYOK, and user-owned adapters
  still pass their supported upgrade and clean-deploy flows.

## Deferred selections and non-goals

The following selections do not block the completed implementation phases
because their contracts are fixed above:

- Stripe Managed Payments eligibility and the resulting explicit
  merchant-of-record mode;
- the authentication library or service satisfying the principal contract;
- the transactional email provider and fallback;
- the production host for DeepSeek V4 Flash 0731 and its fallback; and
- the exact founding-cohort invite and trial policy.

Selection requires a short decision record, a test adapter where applicable,
operational ownership, and review of data handling and termination behavior.

The first launch does not include Workers for Platforms, customer-uploaded
Worker code, a permanent free tier, WhatsApp, SMS, Telegram groups, multiple
active GSVs per Telegram identity, invited members, handle rename, retired
handle reuse, custom domains, user-only storage encryption, or self-hosting the
default model weights. These may be added only without weakening the core
invariants.

## Founding-cohort measures

The cohort validates the product rather than only infrastructure. Measure:

- signup-to-provisioning completion and time to first successful agent run;
- percentage linking Telegram and returning through it;
- weekly active installations and retained active installations;
- successful, cancelled, queued, and falsely-completed Process outcomes;
- median and tail inference latency, cache rate, model fallback rate, and
  upstream cost per active installation;
- storage and adapter delivery cost per active installation;
- percentage approaching or exceeding fair-use limits;
- recovery, payment-failure, support, export, and deletion incidence; and
- cross-boundary authorization, routing, or cleanup failures, whose acceptable
  target is zero.

No product-content telemetry is required to compute these measures.

## Decision log

- 2026-08-04: Use ordinary multi-installation Workers and Durable Objects, not
  Workers for Platforms, while all installations run trusted GSV code.
- 2026-08-04: Make immutable installation identity the outer state, routing,
  authorization, billing, export, and deletion boundary.
- 2026-08-04: Preserve local multi-user Kernel semantics while presenting one
  owner by default in the managed product.
- 2026-08-04: Bundle provider-neutral GSV Intelligence; evaluate DeepSeek V4
  Flash 0731 as the initial text and agent model without exposing it as the
  durable product contract.
- 2026-08-04: Include one shared managed Telegram bot with web-confirmed account
  linking; defer WhatsApp and Telegram groups.
- 2026-08-04: Bill per GSV installation with provider-neutral entitlements,
  founding pricing of USD 20 per month, intended list pricing of USD 29 per
  month, and no permanent free hosted tier.
- 2026-08-04: Use Stripe hosted Checkout and customer portal as the first
  replaceable billing adapter; require an explicit direct-versus-Managed-
Payments merchant mode instead of embedding that choice in entitlements.
- 2026-08-05: Give managed and standalone Workers distinct production names;
  expose only account, Telegram webhook, and wildcard Gateway routes; bootstrap
  the cyclic service graph with inert named entrypoints; and keep inference and
  ripgit service-binding-only.
