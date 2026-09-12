# Hosting consolidation: engineering specification

Status: ready for implementation, revision 5, 2026-09-11. Companion to the
[hosting consolidation brief](./hosting-consolidation-brief.md) and the
[unified hosting and web release plan](./unified-hosting-and-web-release.md).
The brief says what and why; this document says how, in what order, and
what "done" means for each piece. This revision incorporates the agreed
public/private split, Accounts recovery authority, full deletion, and the
review corrections into the implementation sections. Revision 5 also makes the
public inference executor a required component and adopts “your GSV” / “space”
as product vocabulary. Earlier discussion is
preserved in [the review history](./hosting-consolidation-review-history.md).

## 1. Goal

One public GSV stack that any operator deploys to a Cloudflare account and
that supports one or several isolated installations. H&M runs that same
stack as one operator among others. The standalone path is removed at an
announced cutover.

Three audiences use the result, and they are three operators of one product,
not three products:

- H&M operating gsv.space for the public.
- A person operating one installation on their own Cloudflare account.
- A company operating GSV for its own people, or building its own agent on it.

What differs between them is operator configuration and which optional
services are attached. Nothing differs in the runtime.

The public stack is complete without an H&M account or private repository.
It includes simple production-capable service implementations. H&M may
provide private commercial implementations of the same public contracts;
enterprises may use their own provider accounts or purchase those services.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Operator** | Whoever owns the Cloudflare account, the domains, the messenger applications, and the deployment. |
| **Space (installation)** | One isolated GSV: its Kernel, processes, conversations, storage prefix, repositories, adapter routes, local accounts, peers, links. Identified by an immutable installation id. |
| **Accounts** | The required operator-level authority for installation ownership, provisioning, recovery, and lifecycle. Its public implementation is `workers/installations`; H&M currently implements it in the private accounts service. |
| **Directory** | Accounts' hostname and immutable-installation lookup interface, consumed by the gateway and other services. |
| **Local account** | A human or agent account inside an installation, with a uid. Created and owned by the Kernel (`workers/gateway/src/kernel/accounts.ts`). |
| **Peer credential** | What a machine (daemon, browser, adapter) holds: a credential issued under an existing owner's uid and bound to a target. Device pairing issues these. A machine is not a local account. |
| **Principal** | A sign-in identity at the directory level. |
| **Ownership** | An Accounts row recording the principal authorized to administer, reset, delete, and recover root for an installation. Today the `memberships` table, whose rows are all `owner`. Ordinary installation sessions still use Kernel credentials. |
| **Bootstrap claim** | A single-use, expiring secret that creates the first installation or the first operator credential of a deployment. |
| **Operator credential** | The long-lived, rotatable credential an operator administers a deployment with when Cloudflare Access is not in front of it. |
| **Overlay** | An operator's private composition on top of the public deployment package: domains, admin configuration, secrets, environment policy, resource adoption. |
| **Reference service** | A small public implementation that satisfies the production contract and can be used unchanged by an operator. |
| **Commercial service** | An optional operator implementation of a public contract, such as H&M-funded inference with credits and charging policy. Its implementation may remain private. |

Product copy says **your GSV** or **space**. `installationId` remains the
immutable technical identity; this vocabulary change does not rename existing
Durable Objects, storage prefixes, database rows, or wire fields. The Accounts
component is named for its ownership and lifecycle responsibility.

The word **managed** is retired from public vocabulary: component names,
bindings, environment variables, and documentation. Persisted identifiers
keep their spelling until migrated under W4's naming inventory.

## 3. Boundaries mapped to code

| Boundary | Owns | Where it lives after this work |
|---|---|---|
| Operator | Cloudflare resources, domains, installation administration, messenger application credentials, required inference execution and optional services (funding, mail, telemetry, admin access) | `deployment/` (public composition), the operator's overlay (private), adapter worker secrets |
| Accounts | Directory, ownership, onboarding, root recovery authorization, installation reset and deletion coordination | `workers/installations`, required by the common deployment |
| Installation | Local accounts, agents, conversations, files, memory, credentials, permissions, peers, linked external identities | `workers/gateway` Kernel and its Durable Objects, keyed by installation id |
| Local account | Identity and access within an installation | Kernel account model (`accounts.ts`, `account-access.ts`) |
| Inference | Provider execution, catalog metadata, media processing, request deadlines, cancellation and operational usage limits | Required public executor, shared with operator implementations |
| Optional services | Commercial funding and policy, mail, or other capabilities behind public interfaces | Public reference implementations or operator-owned services; the owning service also implements lifecycle cleanup |

Ordinary human sessions sign in to an installation through the Kernel's
setup and connect calls. The Kernel authenticates human, machine, and
service credentials. Accounts authenticates owner principals for ownership
and recovery; it authorizes a root credential reset through a dedicated
trusted contract. Directory lookup does not itself create a local session.
Shared provider execution, cancellation, streaming, and fallback remain
public machinery used by both reference and H&M commercial services.

## 4. Implementation slices

Hosting consolidation is one workstream. W1–W8 are its internal slices,
each delivered through one or more pull requests. Order is in section 5.
Independent bugs and improvements have separate issues and branches. Fix
generation reliability tracked in
[#308](https://github.com/deathbyknowledge/gsv/issues/308) in the current
runtime, then carry that fix into this extraction.

### W1a. Directory contract and ownership schema

Preserve current admission and credentials. Reviewable on its own.

The gateway binds `INSTALLATION_DIRECTORY` (`runtime-env.ts`) and calls
`resolveInstallation` from `installation/routing.ts` and `lifecycle.ts`; the
service type is exported from `@humansandmachines/gsv/services/directory`.

Tasks:

- Document `InstallationDirectoryService` and `InstallationOnboardingService`
  in `docs/architecture/` as the operator-to-installation contract: resolve
  by installation id, resolve by trusted hostname, onboarding claims,
  lifecycle gates (work gate, reset, deletion), ownership, and the
  installation states the public schema holds (`reserved`, `provisioning`,
  `trialing`, `active`, `past_due`, and the rest of the CHECK list), with the
  work gate remaining active-only.
- Retire `role` and `local_uid` on `memberships` together through the next
  cleanup migration after a compatible preparation deployment. That first
  deployment adds an `owner` default for the existing role column and stops
  provisioning/reset writers and readers from using either obsolete column.
  Only after it is deployed and older requests are drained does a follow-up
  migration remove both columns. Keep the removal out of the preparation
  release's migration directory, since migrations precede Worker deployment.
  The table records ownership and no Kernel role or uid. Do not edit the
  original shipped schema or renumber local accounts.

Acceptance: the contract is documented; the migration applies to the
existing D1 and to a fresh one; existing resolution, onboarding, reset, and
credentials remain valid. Complete data deletion is added in W2b.

### W1b. Owner as root; people, invitations, and recovery inside the Kernel

The owner administers the installation through its existing root account
(uid 0). Setup creates the ordinary human account separately; root receives
the chosen root password, or initially the human's password when no custom
one was supplied. Preserve both accounts, credentials, homes, agents, and
links on upgrade. This work does not convert the ordinary human uid to 0.
Accounts records ownership; the Kernel owns local people and access.

**People.** Root is responsible for every account in the installation: root
invites people, removes them, and sets their passwords. Members have no
principal anywhere; they exist only as local accounts.

**Invitations.** A person joins an installation the way a machine does, and
in the same place. Device pairing (`packages/gsv/src/protocol/pairing.ts`)
mints a single-use, expiring invitation that the Kernel consumes
atomically; for a machine the outcome is a peer credential under the
issuer's uid. A human invitation is the same mechanism with a different,
fixed outcome: a local human account.

- An invitation fixes at mint: its purpose (human account or peer
  credential), its installation, its issuing local account, and the
  enrollment it permits (the username for a human; the target for a peer).
  The recipient cannot change any of them at redemption, and a peer
  invitation cannot enrol a human.
- The invitee opens the invitation on the installation's own hostname and
  sets their local credential there. Consumption and account creation are
  one Kernel operation, atomic and idempotent per claim: a repeated
  redemption by the same recipient completes the same enrollment; a
  different recipient is refused.
- Bind a recipient-generated redemption proof and the credential being
  enrolled on first consumption. A lost-response retry must prove that same
  redemption and recover its result; possession of the invitation alone
  after consumption cannot replace the new account's credential. Store
  proof material hashed and keep the enrollment and receipt atomic.
- Expiry, cancellation, issuer revocation, and installation reset kill a
  claim before consumption.

**Removal.** A Kernel operation by root on the local account. Revoking a
local account refuses new sessions and credentials, fences that account's
adapter links at the next delivery, and does not kill work already
admitted. The operator's lever remains disabling the whole installation.

**Recovery, in layers.**

1. A person who forgot their password receives a one-time code through a
   messenger they linked earlier, inside the Kernel, which owns the link and
   knows the signed-in human confirmed it. Or root resets it.
2. Root recovery uses the owner principal. Accounts freshly authenticates
   that verified owner at the operator's front door and authorizes a
   short-lived, single-use root reset claim. The owner redeems it at the
   installation, where the Kernel changes the credential. Accounts is a
   trusted recovery authority; no additional owner-held recovery key is
   required by this design.

The gateway exposes a dedicated recovery entrypoint whose service binding
is granted only to Accounts. Its authority comes from deployment-owned
binding configuration. The existing outbound directory lookup binding does
not authorize an incoming reset request. Fix the immutable installation id,
reset purpose, and recovery attempt in the claim; the Kernel atomically
consumes it and replaces the root password. Invalidate pre-reset root
credentials and sessions so they cannot undo recovery. Ordinary
human accounts retain their credentials. Log outcomes without claim secrets
or credential material. Retired-installation claims remain invalid after
hostname reuse.

Password sign-in remains the local credential throughout consolidation.

**New Kernel operations this needs:** a root-only operation to set another
local account's password, exposed in Settings; a recovery-code flow over an
existing link; and the Accounts-authorized root reset contract above.
Ownership linking alone changes no credentials.

Acceptance:

- Concurrent redemption of one claim creates one account; a lost response
  is recovered by the same recipient; another recipient cannot reuse the
  claim; expired, cancelled, revoked, and reset claims fail closed; a peer
  invitation at the human path is refused.
- A second human signs in only at the installation, holds a distinct local
  account, and after removal cannot enter by web, CLI, or adapter.
- Root resets a member's password; a member recovers by messenger code; the
  owner recovers root through Accounts; a principal that does not own
  the installation cannot trigger a root reset.
- Invalid, expired, reused, and wrong-installation recovery claims fail;
  pre-reset root credentials fail afterwards. Existing human credentials,
  CLI/machine credentials, web sessions, and adapter links survive an
  ordinary upgrade.

### W1c. A real owner principal for every installation

Required, because layer 3 of recovery depends on it. Installations
provisioned under the shared registry principal (`admin/service.ts`,
`REGISTRY_PRINCIPAL_ID`) have no real owner principal.

The owner proves both authenticated root of this installation and the
verified external principal being linked. Accounts verifies the principal;
a trusted Kernel operation attests root authorization for its own immutable
installation id. Bind the two proofs to one short-lived linking attempt and
update `installations.owner_principal_id` and its ownership row atomically.
Public input never selects an installation or uid, and supplying a principal
id or email alone does not prove that identity. Ownership linking rotates
no Kernel credentials. Disable owner recovery while ownership still names
the shared registry principal.

Acceptance: two installations provisioned under the registry principal are
claimed by their respective owners; neither can claim the other's; a
principal may own several installations and reach each from its hostname.

**Owner sign-in and My spaces.** Accounts supplies native email-code sign-in
as the first public owner credential. An external OIDC service is optional.
A verified mailbox creates or authenticates an immutable Accounts principal;
its browser session opens My spaces, which lists only that principal's owned
spaces. Signing in does not provision a space, enter a local Kernel account,
or grant operator administration. Existing explicit operator provisioning
and first-space bootstrap remain the creation path.

Email verification is an explicit credential, separate from existing OIDC
subjects. Never attach a new credential to an existing principal merely
because their email addresses match. Existing OIDC linking and recovery
remain available. Future Google or GitHub credentials can use the same
principal model after explicit credential linking; those additions are not
part of this batch.

Use six-digit codes with a ten-minute lifetime, five failed verification
attempts, a resend cooldown, and atomic mailbox/IP send limits. Codes,
browser proofs, sessions, and throttle identifiers are stored as hashes or
keyed verifiers; plaintext codes appear only in the transactional email.
Consumption and session issuance are atomic. Lost-response retries require
the same browser, code, purpose and prepared session credential, and recover
the same result. A resend retains the original expiry and consumes send quota.
Expired attempts and sessions have bounded cleanup. Per-space deletion
removes its linking and recovery attempts while preserving the owner's
global identity and access to their other spaces.

Root recovery always requires a fresh email verification bound to that exact
space's current owner and recovery attempt. An ordinary My spaces session
cannot authorize a root reset. Linking still requires the Kernel's current
root authorization in addition to fresh owner verification. Browser and
purpose binding remain enforced through retries and ownership changes.

Accounts sends codes through an operator-configured mail binding independent
of every Kernel and linked messenger. The Cloudflare reference uses Email
Sending with a verified sender and a stable, deployment-owned verifier
secret. Mail acceptance failures remain visible; the page must not claim a
code was sent after a failed delivery call. This lets an owner recover a
space even when that space's own mail or credentials are broken.

### W2a. Public services and private commercial implementations

Publish the contracts and a complete reference deployment. Keep H&M's
commercial implementation private behind those same contracts.

| Component | Public GSV | H&M private implementation |
|---|---|---|
| Accounts | `workers/installations`: directory, principals, ownership, onboarding, administration, recovery authorization, reset and deletion coordination. Required for every deployment. | Commercial account operations may call Accounts; they do not replace its installation identity or create a second Kernel admission path. |
| Inference runtime | Required public execution service: provider adapters and SDK, model metadata, text/image/audio operations, request identity, streaming, cancellation, provider fallback, isolation, and usage reporting. | Reuse the public runtime; supply commercial funding and accounting policy. |
| Reference inference | Required `workers/inference`: user- or operator-supplied credentials, configured routing and basic per-installation limits, durable request state and usage counters. Deployable unchanged with no H&M dependency. | Funding eligibility, credits/allowances, customer charging and reconciliation policy, pricing decisions, and commercial administration. |
| Other service contracts | Public interfaces, contract tests, and simple implementations for enabled capabilities. | Operator-specific commercial implementations, credentials, and operational tooling. Future subscriptions/billing may remain private; building them is outside this consolidation. |

The reference inference service keeps request state and basic counters in
installation-scoped Durable Objects. It needs no H&M pricing seed, customer
table, commercial account, or private repository. Operators configure their
provider bindings and limits. Both implementations must pass the same
streaming, cancellation, attribution, isolation, and lifecycle tests.

**Execution boundary.** Process retains context assembly, prompt epochs, history,
compaction decisions, tool execution, model-stack selection and fallback, run
lifecycle, and stale-result fences. Kernel retains credential ownership and
OAuth refresh, permissions, model preferences, and target authorization. The
inference Worker executes requests and owns provider transport, normalization,
execution deadlines, cancellation, provider-attempt fallback, and usage. The
provider SDK and catalog leave the gateway runtime bundle; the gateway does not
use the Workers AI binding directly after the cutover.

Kernel authorizes a connection for an immutable installation and actor. Only
its request-scoped credential and transport capability cross into inference;
long-lived credentials remain Kernel-owned and are never persisted in request
state or telemetry. Process can consume the resulting stream directly without
routing individual tokens through Kernel. Machine transport remains supported
through an authorized, request-scoped `net.fetch` capability: preserve byte
streaming, cancellation, disconnect cleanup, and the selected target's authority.
A provider update can deploy independently of the gateway. It must still bound
and settle interrupted inference requests; independent deployment is not a
promise that in-flight requests survive a Worker or DO restart.

Acceptance additionally covers user-supplied provider credentials, custom
endpoints, operator binding credentials, and machine transport through the same
execution contract. Test machine streaming/cancellation/disconnects across the
actual RPC boundary, and prove the gateway bundle contains neither provider
SDK runtime nor direct Workers AI execution. Model-stack fallback that changes
context limits continues to rebuild context in Process.

**Accounts extraction.** Move the general code and these directory tables:
`principals`, `installations`, `hostnames`, `memberships` (ownership),
`provisioning_operations`, `installation_reset_operations`, and
`installation_onboarding_claims`. Add recovery, ownership-linking, and
deletion-operation records through new versioned migrations. Public access
verification has Cloudflare Access and operator-credential implementations;
the public owner-verification contract also supports the configured identity
provider. Keep operator administration and proof of an individual owner's
principal distinct when they are different actors.

H&M retains ownership of its existing `managed_inference_policies`,
`managed_inference_control`, `managed_inference_routing`, and
`managed_inference_usage_events` tables and commercial operations. Their
physical names stay unchanged during adoption. The private repository holds
the overlay and commercial services; shared installation and inference
runtime code moves public.

**Contracts at the separation.** Extend the existing service interfaces in
`packages/gsv/src/services/`; the gateway continues using one runtime path.
Replace every cross-owner read or write, including these existing callers:

| Existing coupling | Owner and replacement behavior |
|---|---|
| `accounts/src/inference-policy.ts:resolve` joins installation state into funding policy. | The inference service resolves installation admission through Accounts and combines that result with its own policy. Unknown or non-active installations cannot start inference. |
| `setInstallationPolicy` reads installations while updating funding policy. | The funding owner validates the installation through Accounts and persists only its own policy. |
| `accounts/src/admin/service.ts` joins policy and usage into installation lists and details. | Accounts requests installation-scoped policy/usage summaries from the optional service; absent services have no panel. |
| `accounts/src/store.ts:resetInstallation` copies and disables inference policy in the directory transaction. | Accounts records the reset operation; the inference owner durably prepares the replacement's configured policy and disables the retired identity's policy, idempotently for that operation. |
| Foreign-key cascades or directory deletion implicitly remove service records. | Explicit owner cleanup and acknowledgements in W2b. Each service fences later writes for the retired identity. |

Accounts commits the old identity inactive and the replacement reserved,
with the reset operation and participant list, before invoking service
preparation. It records each acknowledgement and retries lost responses with
the same operation id. Completion of setup may activate the replacement
only after required preparation succeeds. Erasure of the old identity runs
separately and does not block an already-prepared replacement. Preserve
retry state until required policy transfer has completed; never erase its
source first.

The work gate stays active-only. Preserve the existing public state enum,
including `trialing` and `past_due`, for compatibility. This extraction adds
no automatic transition between those states based on commercial policy;
the current policy resolver reads state rather than writing such transitions.

**One D1 for adoption, explicit migration ownership.** H&M keeps its current
database and resource id. Public Accounts and H&M's policy/usage service may
bind that database with separate migration ledgers. This separates schema
ownership; table-level security isolation is not supplied by sharing a
binding. The public reference inference service uses its own DO storage.

The migration handoff is:

1. Freeze the legacy migration runner for this deployment and inventory its
   applied migration records, schema, and checksums. Assign current Accounts
   files `0001`, `0002`, and `0006`, plus W1a's new ownership migration, to
   the directory. Files `0003`–`0005` and `0007`–`0009` remain with H&M's
   inference policy/usage owner. Classify any newly landed migration before
   cutting the release; no file may have two active owners.
2. Copy each owner's shipped SQL unchanged. Under the adoption operation,
   seed that owner's new ledger from verified records in the old ledger,
   then mark its handoff complete. A retry reconciles the same records;
   existing DDL is not replayed. Keep the old ledger as historical evidence
   and stop using it to apply new migrations.
3. Apply new forward migrations only after handoff. The inference owner
   removes foreign keys to directory tables through a data-preserving
   migration, after explicit reset/delete contracts replace the cascades.
   Do not combine this with renaming physical tables or resetting usage.
4. A fresh public deployment runs only directory-owned migrations and
   initializes reference-service DO schemas if enabled. Enabling reference
   inference later must also work. An operator choosing H&M services applies
   their own migrations separately, with the directory present first when
   required by historical SQL.

Adoption is tested with a migration interrupted between owners, repeated
deployment, and a partially initialized new ledger. A mixed or unexpected
schema fails the deployment before worker cutover rather than guessing
which changes happened. Pending resets, usage, reservations, and credentials
survive the handoff. A database split can follow measured capacity or
operator isolation requirements; it is not part of this extraction.

Acceptance:

- Public-only deployments run Accounts and required reference inference
  without H&M code or data. Reference inference handles limits, cancellation,
  fallback, and truthful model attribution through the shared runtime.
- H&M staging uses public Accounts and the shared runtime with its private
  commercial services, preserving existing policy, metering, and resources.
- Fresh and adopted databases, late reference-service enablement, interrupted
  migration, and interrupted reset preparation pass the cases above.
- Source names go neutral, with W4's explicit compatibility mapping for
  persisted names and rolling API consumers.

### W2b. Complete installation data deletion

Finish the existing reset lifecycle. Today reset creates a replacement and
records the old identity's data as `pending` deletion, with no worker that
carries it through erasure. The new path covers those pending records,
future resets, and explicit installation deletion.

Accounts owns a durable operation and per-owner progress, keyed by immutable
installation id and operation id. Each installed service implements trusted,
idempotent quiesce, erase, and status operations for the data it owns. The
same lifecycle contract applies to reference and private implementations.
Progress includes the phase, resumable cursor where needed, last outcome,
retry state, and content-free completion receipt. Missing acknowledgement
means unfinished work; it must never be interpreted as successful deletion.

The coordinator performs these steps:

1. Close ordinary admission and revoke credentials and routes for the
   retired identity. Retain a participant/resource inventory, including
   services previously enabled that still hold its data.
2. Ask every owner to quiesce: stop or cancel active work, fence delayed
   writes and delivery, and cancel owned alarms/retries. Required reset
   preparation in W2a completes before its source data can be erased.
3. Erase owned state in bounded resumable batches, recording acknowledgements
   durably. Preserve process, conversation, repository, and adapter address
   inventories until their owners finish; wiping the Kernel registry first
   must not strand other Durable Objects.
4. Confirm erasure across all owners, retaining only the minimal content-free
   tombstone needed to reject stale work and explain completion. Accounts
   exposes progress and retryable failures. Resume pending or failed work
   after service restart or deployment.

| Owner | Installation data to erase |
|---|---|
| Kernel | Local accounts, credentials, configuration, permissions, schedules, responsibilities, ledger, contacts, links, and pairing/setup/recovery claims. |
| Processes and conversations | Every owned DO's state, history, traces, canonical messages, pending work, and related archives. Process kill alone does not erase a conversation. |
| Storage and repositories | Installation-scoped files, immutable revisions, media, archive objects, incomplete uploads, and ripgit state. |
| Adapters and mail | Installation links, pending pairings, queued payloads, deliveries, and retry receipts. Preserve shared application credentials, another installation's links, and newer route generations. |
| Inference and commercial services | Policy, reservations, request state, metering objects, and detailed usage, including private services. |
| Accounts | Installation-specific ownership, hostname, onboarding, and operation data beyond the minimal deletion record. Preserve a principal's other installations. |

The owner inventory includes operator-controlled telemetry, provider logs,
caches, and backups. Each owner declares active deletion or a concrete
expiry policy and how completion is verified. Report live-data erasure and
any remaining retained copies separately; final erasure cannot be claimed
while a declared retained copy remains. The operation covers data held by
the deployment and its services, preserving other people's conversation
copies and files on connected machines.

Acceptance: a populated installation is reset or deleted; one cleanup owner
fails and later resumes; all inventoried application stores are eventually
empty for the retired identity. Delayed work after erasure recreates no user
data. An existing pending reset also completes. The replacement and another
installation with matching usernames and paths remain usable throughout.
Migration/adoption itself does not initiate unrelated production purges;
already authorized pending deletions are resumed by the explicit lifecycle
job once its data-owner inventory is verified.

### W3. One deployment and bootstrap

`deployment/src/runtime.ts` composes the gateway, ripgit, storage, adapters,
and optional services from `GsvRuntimeProps`. Make it the common
composition. The legacy standalone entrypoint stays supported until W7; W3
does not remove `standalone.ts` or `GsvRuntimeMode`.

Tasks:

- `installationDirectory` becomes required for new deployments; the package
  provisions the public installations worker and its D1 when the operator
  does not supply one.
- Operator inputs: domain, access method (Cloudflare Access configuration or
  operator credential), enabled adapters, inference configuration, optional
  services (funding, mail outbound, telemetry tail consumers), secret references. Optional services
  may be public references or operator implementations of the same
  contracts. Selecting H&M commercial services is explicit and does not
  alter Kernel, onboarding, or messenger flows.
- **Bootstrap versus administration.** The deploy mints a bootstrap claim:
  single-use, expiring, disclosed once as deliberate local output, never
  written to deployment or CI logs. Redeeming it does two things: creates
  the first installation with its setup link, and, when no Access is
  configured, issues the operator credential. The operator credential is
  long-lived, stored hashed, rotatable, revocable, and separate from the
  installation setup claim and from Kernel credentials. Recovery when the
  output is lost is by deployment ownership: a redeploy with an explicit
  rotate flag mints a new operator credential and revokes the old one; it
  never mints a new first installation.
- Redeploy is idempotent: it does not create another first installation,
  reissue consumed setup claims, or rotate operator access unless asked.
- The public inference service is always provisioned or supplied through the
  same contract. Without commercial funding, the deployment base stays the
  configured operator models, and a person's own provider credential extends
  it. Document that Workers AI fallback runs on the operator's resources.

Acceptance:

- A fresh Cloudflare account deploys from the public package with no
  private code, creates two installations, and both complete onboarding
  through setup links.
- The required public inference service works with operator and user-supplied
  credentials and limits. Disabling commercial funding leaves user-supplied
  credentials usable through that same execution service.
- Repeating the deployment, and interrupting bootstrap midway, creates no
  second first installation and reissues no consumed claim; setup-claim
  expiry and reissue, and operator credential rotation and recovery, are
  exercised.
- With no commercial inference service configured, a conversation on either
  installation is answered by the supplied provider and model, asserted from the run's
  attribution and credential source without exposing the credential, so a
  fallback cannot pass for success.

### W4. Reference operator overlay

H&M's infrastructure repository becomes an overlay on the public package:
domains and zone exclusions, admin access, environment policy, secret
bindings, commercial-service bindings, and Alchemy overrides that preserve
existing resource identities. The private services repository retains H&M's
commercial implementations and consumes the shared public runtime.

Tasks:

- Replace the private `ManagedServices` composition with the public runtime
  and Accounts service, plus H&M's private funded-inference and commercial
  services implementing W2a's contracts. The public example composes the
  reference services instead. Both use the same deployment package.
- Adopt, never recreate: the accounts D1, the storage bucket, the mail
  queues, the adapter workers, the inference installations namespace.
- **Naming inventory.** Before any rename, list persisted values, Durable
  Object namespaces and names, exports, binding names, and service
  consumers. Known persisted identifiers that keep their spelling until
  migrated: `managed_telegram_pairing:v1` and `managed_slack_pairing:v1`
  record keys, Telegram's `managed` account id, link metadata
  `managed: true`, and the `managed-shared` route mode. Public vocabulary
  goes neutral; adopted storage keeps its historical spelling behind an
  explicit compatibility mapping, or each item is migrated deliberately.
- **Consumer inventory.** For each rename, record producer, consumers,
  persisted representation, rollout order, and removal release. Include
  public SDK `services/{directory,onboarding,inference,mail}.ts`,
  `protocol/managed.ts`, and stream readers/writers; actual RPC method names
  such as `getManagedInferencePolicy`, `recordManagedInferenceUsage`,
  `acceptManagedInboundMail`, and `unlinkManagedAdapterIdentity`; and the
  independently pinned private services repository.
- Include `deployment/src/manifest.ts`, `scripts/build-deployment-manifest.mjs`,
  adapter JSON entrypoint/DO declarations, Wrangler configs, generated
  environment types, and `scripts/check-managed-deployment.sh`. These are
  consumers of binding, class, and `standalone`/`managed` manifest names.
  Change the published manifest version if its shape changes.
- Include the web's `messengerPresentation.ts` reader of `managed-shared`
  and the gateway's `kernel/adapter-pairing.ts` producer, plus email Worker
  and gateway consumers of mail RPCs and `MANAGED_MAIL_OUTBOUND`. Audit
  CLI/Desktop protocol and deployment consumers; current sources have no
  literal reader of that route-mode value. Preserve actual compatibility
  rather than assuming which client owns a branch.
- Deploy any required callable aliases before switching callers, then remove
  them after the inventoried consumers advance. Source aliases do not
  rename an RPC or migrate a DO namespace. Keep physical storage mappings
  where historical identifiers remain after W7.
- Write `docs/how-to/operate-gsv.md` from the overlay, as if for a third
  party: what an operator configures, what they get, what remains theirs.

Acceptance:

- H&M staging and then production deploy from the overlay with resource
  identities unchanged, verified against the Alchemy state before and after.
- A private commercial service passes the same admission, streaming,
  cancellation, reset-preparation, and deletion contract tests as the public
  reference. Public Accounts has no dependency on its private tables.
- Existing links, pending pairings, queued deliveries, and retry receipts
  continue working after adoption; nobody pairs again.
- The how-to is sufficient for an engineer outside H&M to deploy the fresh
  account of W3 without asking questions.

### W5. Messengers on one model

Three layers of ownership:

- **Application credentials** (Telegram bot token, Slack app id and signing
  secret, Discord bot token, mail sending domain) are the operator's, set at
  deploy, stored as adapter worker secrets, never in a Kernel.
- **Installs into external spaces** (a Slack workspace, a Discord server) are
  held by the adapter, keyed by the external space. The Slack worker's
  workspace object keyed by team id is the pattern. A space carries no
  installation and identifies none.
- **Identity links** are per actor: an external identity bound to a local
  account through `adapter.pair.info`, `inspect`, `confirm`, `disconnect`,
  listed by `sys.link.list`. The Settings messengers section renders this.

**Routing scope, decided.** The Slack peer is scoped by adapter account and
actor (`managed-identity.ts`); the actor's authorized link selects the
installation and local uid. That generalises:

- In a shared space, the routing scope is the operator's adapter
  application, the space, and the actor. Two colleagues in one workspace
  reach two different installations through their own links.
- In a DM, with no space, the scope is the operator's adapter application
  and the actor. It is never the provider identity globally across
  operators.
- On DM transports an actor holds one active link per operator application
  per adapter. Linking elsewhere moves it. Discord's DM route and its
  server-scoped links coexist under the same actor, each resolved through
  that actor's link.
- Only the signed-in human's confirmation, in trusted Kernel context,
  chooses the destination. A provider webhook or a pairing code cannot.
- Moving a link fences the old route immediately by route generation, so
  delayed ingress and delivery from the old generation are rejected.
  Notifying the previous installation is cleanup, not the boundary.

Tasks:

- Telegram: the template.
- Slack: confirm the pairing code resolves the installation only through the
  signed-in human's confirmation.
- Discord: move from a single-installation gateway bot to the Slack shape:
  server install held by the adapter, per-actor pairing, `pairing: true` in
  the inventory.
- The adapter inventory (`adapter.list`) carries the truth the UI currently
  infers: whether the operator enabled the adapter and whether the person
  may link. Gateway authorization enforces what the inventory advertises.

Acceptance:

- One shared bot serves two installations on the fresh account; each actor
  reaches their own installation and never the other's.
- Two people in the same external workspace reach different installations.
- Moving one link rejects delayed ingress and delivery from its old
  generation without changing the other person's route.

### W6. Validation

**Contract suite, in CI.** Run six scenario groups through each of Telegram,
Slack, and Discord's actual ingress/routing code, gateway admission, and
controlled delayed delivery. Use provider fixtures; no real inference is
needed for these tests.

| Case | Minimum assertion |
|---|---|
| Provider proof and unpaired actor | Invalid provider proof and a valid unpaired actor select no Kernel. Public payload fields cannot choose an installation id or local uid. |
| Pair confirmation and replay | An authorized human confirmation fixes the route. Unauthorized confirmation fails; a lost-response retry recovers the same result; a consumed code cannot establish another route. |
| Two installations | Two actors under one application reach their own installations with colliding local usernames/uids. For Slack and Discord, test both actors in one external space and their supported DM scope separately. |
| Admission revoked | Restrict the installation, revoke the local account, or disconnect the link between receipt and admission. Each variant refuses ordinary work while the other actor stays usable. |
| Relink with work in flight | Moving an actor fences delayed ingress and outbound delivery from the old generation. Stale cleanup cannot remove the new link or change another actor's route. |
| Provider retry and delivery outcome | Duplicate inbound events admit no duplicate work. A safely retryable send preserves identity and destination; ambiguous provider acceptance follows the adapter's ambiguity policy. |

Test unknown/wildcard hosts once at the shared gateway boundary, asserting
no Kernel allocation. Measure destination selection and admission separately:
invalid provider proof, unknown hosts, and unpaired actors stop before
Kernel selection; local-account checks consult the selected Kernel but
refuse ordinary work when unauthorized. Every admitted request reaches one
authorized installation, and inactive or ambiguous destinations admit none.

Run W1's credential, ownership-proof, invitation, and recovery cases plus
W2's fresh/adopted schema, reset-preparation, and deletion cases in their
owning suites. Contract changes are tested on both caller and service sides.

**Two real-cloud runs, as release gates**, because they fail differently:

- **Fresh**: a new Cloudflare account, public package only, two installations
  with the same usernames and paths, Telegram linking on both, user-supplied
  model credentials. Verify isolation of processes, conversations, storage
  prefixes, repositories, adapter routes, and memory. Restart, reset, and
  delete one; the other is unaffected. This run is destructive and creates
  and destroys only its own provisioned fixtures.
- **Adoption**: H&M staging on public Accounts/shared runtime and its private
  commercial services, with existing resources adopted. Existing web/CLI/
  machine credentials and adapter links keep working. Exercise migration
  interruption, reset preparation, and an existing pending deletion using
  staging fixtures. Existing installations outside the fixtures stay intact.

**Reset semantics.** Process reset (`proc.reset`) and history compaction
(`proc.history.compact`) preserve the installation. Operator installation
reset allocates a fresh installation id, moves the hostname handle, and keeps
the old identity behind inactive routing until each data owner completes
cleanup. Memberships and adapter links are invalidated for the old identity
and explicitly re-established for the replacement. Reusing a hostname never
makes old invitations, credentials, routes, or delayed work valid for the
new installation.

Acceptance: the replacement is reachable after setup and required service
preparation; old credentials, claims, routes, and work cannot reach it.
Populate every W2b owner, interrupt cleanup, resume, and verify actual erasure
for the retired identity while the second installation stays usable. Replay
delayed work after completion and verify no user data is recreated. Inspect
and report any retained log/backup copies until their declared expiry;
clearing live tables alone does not establish final erasure.

### W7. Remove the standalone hosting path

One pull request, after a last verified standalone release is tagged and
documented, and after W6's gates are green.

Remove the executable legacy hosting paths: `SINGLETON_INSTALLATION_ID` and
its guard in `installation/identity.ts`; the standalone branches in
`index.ts`, `runtime-env.ts`, and `kernel/adapter-pairing.ts`;
`deployment/src/standalone.ts` and `GsvRuntimeMode`; alternate adapter
entrypoints; ripgit's legacy installation addressing; the
`standalone-process-upgrade` tests; the standalone sections of `docs/`.
Keep isolation and security regression tests that those compatibility tests
carried. Update the engineering contract to record the cutover.

Acceptance is measured by executable behaviour, not by grep: one routing
path in the gateway, no legacy entrypoint deployable, every protocol and
deployment consumer in the cutover inventory updated. A reviewed allowlist
covers remaining mentions in migrations, design records, the changelog, and
unrelated uses of the words (for example the standalone Unix groups in
`kernel/auth-store.ts`).

### W8. Enterprise door

A page, "run GSV for your organisation", and a contact address. No billing,
no SSO beyond Access, no audit exports until a company asks and says which.

## 5. Sequence and rollout

1. W1a documents the public boundary and migrates ownership columns. Publish
   W2's caller/service contracts and W4's migration/rename inventories before
   moving implementations.
2. W2a extracts public Accounts and shared inference machinery, provides the
   reference service, and connects H&M's private commercial services. Prove
   the migration handoff through W4's staging adoption.
3. W1b/W1c implement people, invitations, recovery, and verified
   owner linking while preserving existing credentials. W2b completes
   deletion across all data owners and resumes pending resets.
4. W3 supplies the common deployment/bootstrap and the public-only fresh
   account flow. W5 aligns messengers, using Telegram/Slack as templates and
   moving Discord to actor-scoped links.
5. W6's CI contracts and both real-cloud gates pass, including full deletion,
   admission, upgrade compatibility, and private/reference service behavior.
6. W4 moves H&M production to the public composition with its private
   services and publishes the operator guide.
7. Tag the last verified standalone release before the first incompatible
   change, wherever that falls in the earlier slices. Announce the cutover;
   W7 removes the legacy path only after W3 replaces it and W6 passes.
8. W8 may ship whenever its page is ready; it has no runtime dependency.

CI contracts are added with the owning slice, rather than deferred until the
last gate. Within this workstream, independent slices may overlap after their
contracts are fixed. Extraction preserves existing deployment behavior;
onboarding/recovery additions, full deletion, and messenger changes are
deliberate new behavior with their own tests. All coordinated renames follow
W4's inventory, and historical physical identifiers retain explicit mappings.

## 6. Invariants

- The immutable installation id is the security boundary. Trusted hostname
  routing resolves an installation before any Kernel is touched. An unknown
  hostname never allocates state.
- Processes, conversations, storage, repositories, adapter routes, and memory
  are installation-scoped. The contract suite proves it on every change.
- Existing installations keep identities, data, credentials, and links across
  adoption. Explicit reset allocates a fresh identity; reset and deletion
  erase retired installation data through W2b's durable operation.
- Extraction preserves Alchemy resource identities, persisted identifiers,
  and data until an authorized lifecycle operation removes it.
- Accounts is required and trusted for owner verification and root recovery.
  The Kernel owns credentials and local authorization; commercial services
  use the same public admission and lifecycle boundaries as reference services.
- Registration is closed by default. First setup uses Accounts' one-time
  onboarding authorization; later humans join through Kernel invitations.
  Existing credentials remain valid, and only an authorized signed-in human
  chooses where an external identity is linked.
- Erasure completes only after every data owner confirms it. Stale operations
  cannot repopulate deleted user data or follow a reused hostname into a new
  installation.

## 7. Out of scope, recorded

- **Own hardware.** GSV depends on Durable Objects, R2, D1, Queues, email
  routing, and Workers AI. workerd is open source; what replacing each
  primitive costs is unestimated, and nothing here assumes it is small.
- WhatsApp Business as the future WhatsApp transport; iMessage.
- Changes to Send-tool semantics.
- Any licence change; GSV remains MIT.
- Building subscriptions, billing integrations, enterprise SSO beyond Access,
  or audit exports. H&M may keep commercial implementations private behind
  the agreed public interfaces; that does not add these products to scope.
- Framework work beyond retaining the extension points that exist: prompts
  and skills as directories, the web shell, the SDK. Packaging the shell,
  generalising prompts, or committing to a framework SDK waits for a concrete
  operator who requires it.
- Automatic migration for legacy standalone deployments. Identify remaining
  users, keep the last standalone release available, and agree recovery
  individually.

## 8. Risks

- **Resource adoption.** Recreating the accounts D1 or the storage bucket
  would lose every installation. Adoption is verified against Alchemy state
  in W4 before production; the fresh run never touches H&M resources.
- **Persisted names.** Renaming a reader without its stored identifier
  orphans state without touching any Cloudflare resource. The W4 inventory
  is the control.
- **Owner principals.** Backfilling ownership from the registry principal
  by username or usage uid would let one person claim another's
  installation and, through recovery, its root. W1c requires authenticated
  root and the verified destination principal, bound to the same operation.
- **Root reset.** The directory-to-Kernel reset is the most powerful
  recovery operation. Accounts is its trusted authority; a dedicated service
  capability authorizes an installation-scoped, single-use claim consumed
  by the Kernel. A caller cannot acquire this authority by claiming an
  Accounts identity in a request.
- **Interrupted extraction.** Interleaved legacy migrations and reset policy
  writes require W2a's owner ledgers and durable preparation receipts. A
  partial deployment cannot replay old DDL or lose an unfinished operation.
- **Orphaned data.** Removing the Kernel registry before enumerating its
  children, or allowing delayed writes after cleanup, can leave data behind.
  W2b preserves resource inventories, fences writers, tracks every owner's
  progress, and includes existing pending resets.
- **Duplicate implementations.** A small public reference must remain usable
  in production. Shared inference machinery and contract tests keep private
  commercial policy from becoming a second generation runtime.
- **Bootstrap.** A single-use claim that doubled as the administration path
  would leave an operator locked out after first use. The claim and the
  operator credential are distinct, and recovery is by deployment ownership.
- **Shared bots across installations.** The link-per-actor scope and route
  generations must hold in routing before Discord ships, or a message can
  reach the wrong Kernel.
- **Scope creep from the framework audience.** Requests to generalise beyond
  what an operator needs are deferred until an operator asks.
