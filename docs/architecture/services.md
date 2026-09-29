# Service contracts

GSV includes public Accounts and inference Workers alongside its Gateway.
Their stable Worker RPC contracts live under `packages/gsv/src/services/`.
Accounts implementation lives in `workers/installations/`; provider execution
lives in `packages/inference/`, hosted by `workers/inference/`. An operator may
keep commercial policy, accounting and funded-provider credentials private
while consuming these public components.

The current contracts are:

- `directory`: hostname and installation identity resolution
- `onboarding`: one-time installation setup authorization and completion
- `entitlements`: a versioned, cacheable map of deployment policy values
- `inference`: streamed model inference and cancellation
- `mail`: Gateway mail transport and operational mail inspection
- `web-search`: optional provider-neutral search implementation for the `gsv` target
- `adapters`: external messaging transport discovery and operations

[Installation directory and onboarding](./installation-directory.md)
specifies installation identity, state gates, ownership, setup claims, and
the current reset/deletion boundary for directory implementers and callers.

Service bindings are capabilities. A deployment must bind only the interface a
Worker needs; Cloudflare Access identity does not implicitly propagate through a
service binding. Implementations validate arguments at their public boundary and
derive installation identity from trusted routing or durable state rather than a
user-controlled field.

## One deployment model

Every deployment supplies directory, onboarding and inference execution bindings.
The public deployment package composes these services for one or many isolated
spaces. A missing or unavailable directory fails closed; it never selects a
singleton Kernel. The model stack starts with `gsv/default`, which the operator's
inference service resolves. User-configured providers use that same execution
boundary, including transport through a connected machine.

Operators may add entitlements, funded inference, mail and other services. H&M's
private overlay is one consumer; its pricing, payment and commercial credential
policy need not become public. The public reference deployment works without
those services, using the operator's Workers AI account or a person's model
credentials.

Local development uses the same public composition. Separate integration
fixtures exercise private service contracts; they do not define another runtime
mode. Preserve existing operator resource identities when adopting the public
components, as described in the [deployment guide](../how-to/deploy-with-alchemy.md).

## Entitlements

Entitlements answer what an installation may use. Keys are strings such as
`inference.included` or `email.daily_messages`; values are booleans, numbers, or
strings. Missing keys mean the feature is not entitled.

Consumers may cache an entitlement snapshot until `refreshAfter`, normally for
five to fifteen minutes, but must not use it after `expiresAt`. Entitlements do
not replace strong usage accounting: inference, email, and other metered services
still own their reservations, counters, idempotency, and settlement.

## Inference deadlines

The Gateway starts one generation budget before acquiring the managed inference
target and forwards its absolute epoch-millisecond `deadlineAt` with `timeoutMs`.
The service uses the earlier of that deadline and its own accepted time plus
`timeoutMs`; omitting the deadline retains the legacy service timeout budget.
An absolute deadline may only shorten the budget, including time already spent
acquiring the target or waiting for the stream RPC.

Deadline expiry produces an error and invokes `abort(logicalRequestId, "timeout")`.
Explicit cancellation uses `abort(logicalRequestId)`; omitted reasons mean
`"cancelled"`. The service retains the first terminal cause, including when an
abort arrives before the generation RPC. The Gateway settles promptly, disposes
acquired targets, and cancels late response bodies without exposing their output.

Failed-attempt telemetry may include `timeoutKind` (`first_output` or
`generation`), elapsed `firstActivityMs` and `lastActivityMs` for nonempty response
body chunks, and `outputExposed`. These fields contain timing and outcome data.

`logicalRequestId` identifies an inference invocation for execution, cancellation
and usage accounting; `actor.processId` and `actor.runId` group related attempts.
A deliberate Process retry or model fallback advances a persisted run revision
before announcing the retry. Reconstructing that run preserves the revision,
while revision zero retains identities admitted before this field existed.
Compaction is an awaited invocation with no durable operation to resume: each
generation admission, retry, fallback or later manual attempt allocates a new
persisted ordinal before dispatch. Repeating an unchanged compaction input does
not reopen a completed invocation.

## Web search

An optional `WEB_SEARCH` binding implements the native `gsv` target's
`web.search` syscall. Gateway acquires an installation-scoped service capability
and forwards a validated query, request identity, and deadline. The service owns
provider credentials, quotas, cancellation, and cleanup. The binding is the
implementation transport; target selection remains ordinary syscall routing.
Cancellation and deadline expiry release the Gateway call without waiting for
the provider's cancellation RPC. The Gateway defers that notification and
disposes the acquired target; the service must enforce the supplied deadline.
Connected providers can advertise `web.search` without this binding or a messaging
adapter. See [Web search](../reference/web-search.md).

## Adapters

Adapters are an extension system, not a closed list of messenger brands. An
adapter Worker implements `AdapterService` and returns an
`AdapterServiceDescriptor` describing its public name, supported lifecycle
operations, surface kinds, and media directions. The Gateway discovers adapter
bindings by their `CHANNEL_*` deployment identity and verifies that the returned
descriptor agrees with that trusted identity.

Telegram, Discord, and Slack are bundled implementations. Matrix,
Signal, IRC, a game chat, or a future transport can implement the same contract
without adding a Kernel-specific RPC.

One Worker per trusted adapter implementation is the normal deployment boundary.
It keeps provider SDKs, webhooks, credentials, retries, and failures isolated;
adapter accounts or peers live in adapter-owned Durable Objects rather than one
Worker deployment per account.

A future third-party marketplace can place an adapter dispatcher behind one
trusted binding and run uploaded implementations in Workers for Platforms. That
dispatcher must enforce code provenance, secret grants, resource limits, and the
same `AdapterService` semantics. The public deployment does not depend on that hosting product.
