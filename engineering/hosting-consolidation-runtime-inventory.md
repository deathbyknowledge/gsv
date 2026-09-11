# Hosting consolidation: runtime and consumer inventory

This is W4's inventory before the public naming cutover. It supplements the
[schema adoption inventory](hosting-consolidation-migration-inventory.md) and
[messenger inventory](messenger-consolidation-inventory.md). It describes the
September 11 implementation; it is not evidence that the remaining cutover or
cloud validation has happened.

The user-facing unit is a **space**, or **your GSV**. The immutable security and
storage key remains `installationId`. Renaming product copy never rewrites an
installation ID, a durable address, an origin, or an existing credential.

## Rollout boundaries

Use these checkpoints in the tables below; no numbered release has been assigned
to them yet.

- **Alias release:** servers expose neutral RPC and module names alongside the
  old callable names. Existing Workers and independently pinned consumers remain
  functional. Storage addresses do not change.
- **Consumer release:** public and private consumers use the neutral names; the
  H&M overlay pins those exact revisions and validates the existing deployment.
- **Cutover release:** after W6 and the last standalone tag, W7 removes old
  runtime branches, exported source aliases, and obsolete build inputs. Physical
  compatibility mappings remain where they address data still in use.

A TypeScript export alias does not create a Worker RPC alias. Each callable
method must be exposed by the deployed server before its callers change. The
same rule applies to encoded stream events: preserve their captured payload and
ordering contract even when the function or type gets a neutral name.

## Resource identities retained by the H&M overlay

The current overlay is `infrastructure/src/gsv/managed.ts`; the private wrapper
is `gsv-services/deployment/src/index.ts`. Their names may change, but the
resource identifiers passed to Alchemy must not silently change with them.

| Resource | Existing production identity | Existing staging identity | Cutover treatment |
| --- | --- | --- | --- |
| Accounts D1 | `gsv-accounts` | `gsv-staging-accounts` | Adopt the same database ID; public and private owner migration ledgers already govern future changes. |
| R2 | `gsv-managed-storage` | `gsv-staging-managed-storage` | Keep bucket ID/name and the `installations/<installationId>/` prefix contract. |
| Gateway Worker | `gsv-managed-gateway` | `gsv-staging-gateway` | Update the existing Worker and retain its Kernel, Process, and Conversation namespaces. |
| Accounts Worker | `gsv-accounts` | `gsv-staging-accounts` | Keep routes and bindings; replace shared behavior through public Accounts code. |
| Inference Worker | `gsv-inference` | `gsv-staging-inference` | Keep funded-inference namespace; the new executor namespace is a separate explicit resource. |
| Repository Worker | `gsv-managed-ripgit` | `gsv-staging-ripgit` | Retain `Repository` namespace and installation-scoped object names. |
| Email Worker | `gsv-managed-email` | `gsv-staging-email` | Keep `MailInstallation` namespace, provider routing, and outbound consumers. |
| Outbound mail queue | `gsv-managed-mail-outbound` | `gsv-staging-mail-outbound` | Adopt the existing queue, including messages and delivery attempts. |
| Mail dead-letter queue | `gsv-managed-mail-outbound-dead-letter` | `gsv-staging-mail-outbound-dead-letter` | Keep identity and include its contents in deletion/retention accounting. |
| Telegram Worker | `gsv-managed-telegram` | `gsv-staging-telegram` | Retain webhook and shared peer/pairing namespaces; no re-pairing. |
| Slack Worker | `gsv-managed-slack` | `gsv-staging-slack` | Retain workspace, peer, pairing, and OAuth state ownership. |
| Telemetry tail | `gsv-managed-telemetry` | `gsv-staging-telemetry` | Keep routes to declared telemetry owners and retention configuration. |

Alchemy logical keys also carry state: `ManagedGsvAccountsDatabase`,
`ManagedGsvAccounts`, `ManagedGsvInference`, `ManagedGsvStorage`,
`ManagedGsvGateway`, `ManagedGsvRipgit`, `ManagedGsvEmail`,
`ManagedGsvMailCommandQueue`, `ManagedGsvMailCommandDeadLetterQueue`,
`ManagedGsvTelegram`, `ManagedGsvSlack`, and the corresponding binding, DNS,
Access, and email-routing keys. Source symbols can become neutral while these
keys remain explicit overlay mappings. Any logical-key migration requires a
reviewed Alchemy state move and a plan showing no replacement or destruction.

## Durable names and persisted compatibility values

| Representation | Owner/readers | Required handling |
| --- | --- | --- |
| `Kernel`, `Process`, `Conversation`, `Repository`, `MailInstallation` class exports | Deployment package, adapter/build manifests, Wrangler configs, Alchemy namespace declarations | Keep their actual namespaces. A changed source class can retain the deployed export alias; a physical rename requires a distinct migration. |
| `InferenceInstallation` / `INFERENCE_INSTALLATIONS` | Private funded inference and existing overlay | Preserve the adopted namespace. It is distinct from public `InferenceExecutor` / `INFERENCE_EXECUTORS`. |
| `ManagedTelegramPeer`, `ManagedTelegramPairing`; their `MANAGED_TELEGRAM_*` namespace bindings | Telegram `adapter.json`, managed Wrangler config, shared Worker exports, public `GsvAdapterWorker`, private overlay | Neutral source names may export the historical class names. Do not create replacement namespaces through a manifest rename. |
| `ManagedSlackWorkspace`, `ManagedSlackPeer`, `ManagedSlackPairing`; their `MANAGED_SLACK_*` namespace bindings | Slack manifests/configs/exports and the same deployment consumers | Preserve namespaces, OAuth workspace installs, per-user tokens, routes, and pending pairings. |
| Telegram account ID `managed`, peer names `managed:<surfaceId>`, pairing names `pair:<code>` | Shared Telegram router, peer, pairing, Kernel adapter identity | Retain behind a named compatibility mapping. These strings address existing state and delivery receipts. |
| `managed_telegram_pairing:v1`, `managed_telegram_peer:v1:state`, `managed_telegram_peer:v1:inbound:` | Telegram pairing and peer stores | Retain exact KV keys until an explicit storage migration exists. |
| `managed_slack_pairing:v1`, `managed_slack_peer:v1:state`, `managed_slack_peer:v1:inbound:` | Slack pairing and peer stores | Retain exact KV keys and request deduplication identity. |
| `managed_slack_workspace:v1:state`, `:user:`, `:route:` | Slack workspace store | Retain state/key prefixes; an individual space deletion does not delete the shared application/workspace install. |
| `managed: true` link metadata; `managed-shared` status mode | Adapter producers, Kernel adapter-pairing/service, web messenger presentation | Introduce a neutral producer value only after readers accept both; migrate stored links if the old field is removed. |
| `managed-*` delivery IDs | Shared peer pairing and provider delivery deduplication | Preserve in-flight identities across rollout; renaming presentation is not a reason to replay delivery. |
| `managed_inference_*` D1 table names and immutable migration names/hashes | Private policy/usage services and the public adoption inventory | Keep physical names unless a new owning migration explicitly changes them. Never edit historical migrations. |
| `singleton`, legacy unscoped Process/repository names and R2 prefixes | Standalone routing/storage projection and upgrade fixtures | Delete the runtime projection only in W7 after its release gate. Never attribute unscoped historical resources to an arbitrary space. |

The shared Discord classes (`DiscordApplication`, `DiscordPeer`,
`DiscordPairing`) are new resources. The old `DiscordGateway` remains only for
the supported pre-cutover path. Do not delete its state just because a new
server application was deployed; W7's explicit standalone policy owns that
decision.

## Public contract and RPC consumers

The neutral names below are the intended cutover names, not a claim that every
alias is already implemented.

| Current symbol or callable | Neutral form / owner | Producers and consumers | Removal checkpoint |
| --- | --- | --- | --- |
| `ManagedInstallationIdentity`, `ManagedInstallationState` | Existing `InstallationIdentity`, `InstallationState` in `services/directory.ts` | SDK protocol barrel, Accounts, Gateway routing, independently pinned private services | Cutover after all imports advance. Runtime JSON is unchanged. |
| `ManagedInferenceService` | Existing `InferenceService` in `services/inference.ts` | Public/shared inference provider adapter and private funded Worker | Cutover after pins advance; keep `getInstallation` capability contract. |
| `ManagedInference*` request/result/event types | Neutral inference contract names; shared package keeps provider SDK projection ownership | `services/inference.ts`, `protocol/managed.ts`, stream codecs, `packages/inference`, Gateway execution client/projection, private inference | Alias then consumer release; captured stream fixtures must remain identical. |
| `getManagedInferencePolicy` | `getInferencePolicy`, funded policy service | Private Accounts implements; private inference requests policy; SDK `protocol/managed.ts` describes it | Deploy callable server alias first, switch private caller, then remove old method at cutover. |
| `recordManagedInferenceUsage` | `recordInferenceUsage`, funded usage service | Private Accounts implements; private inference reports usage; SDK contract | Same ordering; delayed usage records must still settle exactly once. |
| `acceptManagedInboundMail`, `completeManagedInboundMail`, `claimManagedOutboundMail`, `completeManagedOutboundMail` | `acceptInboundMail`, `completeInboundMail`, `claimOutboundMail`, `completeOutboundMail` on `MailGatewayService` | `services/mail.ts` / `protocol/mail.ts`; Gateway adapter entrypoint and Kernel mailbox/outbound implementation; email Worker intake/outbound paths | Gateway aliases first; email Worker then switches; remove old methods only after pending work is compatible. |
| `ManagedMailService`, `ManagedMailGatewayService`, `ManagedMail*` payload names | Existing neutral service names plus neutral mail payload aliases | SDK, Gateway, email Worker, private mail-summary inference | Source aliases can go after both public and independently pinned private consumers advance. Payloads stay compatible. |
| `unlinkManagedAdapterIdentity` | `unlinkAdapterIdentity` on the attenuated adapter Gateway service | SDK `protocol/managed.ts`, Gateway `AdapterGatewayEntrypoint` / Kernel, Telegram/Slack pairing, shared pairing-claim helper (also Discord) | Gateway callable alias before shared adapters switch. Generation/operation checks remain identical. |
| Legacy Telegram-specific unlink RPC/types | Ordinary adapter unlink above | SDK, Gateway compatibility methods, old adapter revisions | Remove after last old adapter consumer is no longer deployed. |
| `protocol/managed.ts` module/barrel | Owning directory, inference, mail, adapter service/protocol modules | Public SDK exports; private services pins; Gateway, shared inference and adapters | Module aliases remain through consumer release; no duplicate wire contract. |
| `MANAGED_MAIL_OUTBOUND` | `MAIL_OUTBOUND` binding | `GsvRuntime`, generated Gateway env, `runtime-env.ts`, `kernel/outbound-mail.ts`, private overlay and Gateway Wrangler configs | Declare both binding names to the same existing queue before changing reads; then remove old binding. |
| `MANAGED_INFERENCE`, `MANAGED_INFERENCE_INSTALLATIONS` | Required `INFERENCE_EXECUTION` | Gateway feature compatibility checks/configs/types; old deployed Gateway; private inference export | New Gateway already executes through `INFERENCE_EXECUTION`. Remove obsolete inputs after old Gateways leave the rollout. |
| `ManagedServices` private composition | Private operator overlay on public Accounts/runtime plus funded inference | Private deployment package, infrastructure `src/gsv/managed.ts`, overlay tests | Replace construction without changing Alchemy logical IDs; private services must retain only commercial behavior. |

Public Accounts constructors/handlers and common inference execution stay in
GSV. H&M policy, usage accounting, pricing, funding, and commercial secrets stay
private. Public reference funding implements the same service contract without
requiring an H&M account. Account deletion calls each owner explicitly; database
foreign-key cascades are not a substitute for the owner receipts.

## Build, UI, and client readers

| Reader/producer | Current dependency | Cutover action |
| --- | --- | --- |
| `deployment/src/manifest.ts`, `deployment/runtime.json` | Manifest v2, adapter `standalone` plus optional `managed` entries | Publish a new manifest version with one adapter deployment shape. Keep source catalog and output manifest versions intentional. |
| `scripts/build-deployment-manifest.mjs`, `scripts/adapter-catalog.mjs`, `scripts/build-cloudflare-bundles.sh` | Produce/select old adapter entries and bundle paths | Build Accounts, inference, Gateway, ripgit, and enabled shared adapters from the same public package. Keep the provider-SDK-free Gateway check. |
| `workers/adapters/*/adapter.json` | Entrypoint, DO class/binding, required secret, bundle and config declarations | Remove duplicate deploy modes while retaining adopted physical class mappings. Add the shared Discord declaration. |
| `deployment/src/runtime.ts`, `deployment/src/installation.ts`, `alchemy.run.ts` | `GsvRuntimeMode`, `StandaloneGsv`, required directory/inference composition | Remove dead standalone inputs after W6; one public operator composition remains. |
| Gateway/adapter/ripgit Wrangler configs and generated environment types | Separate managed/standalone bindings and names | Regenerate from the actual remaining configs; remove stale files and type references together. |
| `scripts/check-managed-deployment.sh` and CI | Asserts the old split and tests both adapter modes | Replace with common deployment, shared-adapter, resource-adoption, and isolation checks; do not retain a contradictory split check. |
| `kernel/adapter-pairing.ts`, `kernel/adapter-service.ts` | Produce/preserve `managed-shared` status | Coordinate neutral status value with readers and historical metadata handling. |
| Web `messengerPresentation.ts`, `ManagedTelegramOnboardingFlow.tsx` | Read or seed `managed-shared`; component naming | Accept both during transition, then use operator inventory and the common link flow. No per-user application-credential setup. |
| CLI/Desktop/extension protocol consumers | Public SDK/deployment release artifacts | Source search found no literal `managed-shared` reader in `host/` or `extension/`. Their protocol and release/build paths still need validation; absence of that literal is not blanket compatibility evidence. |
| Private `gsv` gitlink and H&M overlay's separate `gsv` / `services` gitlinks | Independently pinned packages and contracts | Pin and build exact revisions, including the private nested SDK, before deploying aliases or removing callers. |

## Evidence required before cutover

For every resource-affecting batch, retain the before/after Alchemy resource
IDs, Worker versions, namespace IDs, D1 ID and migration receipts, R2 identity,
queue IDs, and binding targets. The deployment plan must show updates/adoption
rather than replacement. Test pending pairing/delivery recovery against the
updated Workers, not only with fresh records.

The fresh-account two-space gate and the H&M staging adoption gate remain
separate. Both include same usernames/paths, inference, messaging, restart,
reset, and deletion isolation. Historical deletion additionally requires the
complete verified object inventory, unfinished R2 multipart evidence, and every
declared retention owner. A code commit, an empty current registry, or a
successful inference response does not replace those gates.
