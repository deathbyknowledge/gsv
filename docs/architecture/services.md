# Service contracts

GSV separates its public runtime from optional services supplied by a deployment
operator. The stable Worker RPC contracts live under
`packages/gsv/src/services/`. Implementations may live in this repository, in a
private platform repository, or in an independently operated deployment.

The current contracts are:

- `directory`: hostname and installation identity resolution
- `onboarding`: one-time installation setup authorization and completion
- `entitlements`: a versioned, cacheable map of deployment policy values
- `inference`: streamed model inference and cancellation
- `mail`: Gateway mail transport and operational mail inspection
- `adapters`: external messaging transport discovery and operations

Service bindings are capabilities. A deployment must bind only the interface a
Worker needs; Cloudflare Access identity does not implicitly propagate through a
service binding. Implementations validate arguments at their public boundary and
derive installation identity from trusted routing or durable state rather than a
user-controlled field.

## Deployment shapes

A standalone deployment omits the directory, onboarding, entitlements, and
platform-funded inference bindings. It runs one `singleton` installation and can
use user-configured model providers and any adapter Workers selected by its
operator.

A managed deployment supplies implementations of the applicable contracts and
binds them to the public Gateway. Humans & Machines keeps its account directory,
billing policy, provider credentials, funded-inference economics, managed email
policy, and shared-adapter control plane in its private infrastructure. Those
implementations are not required to build or develop the public runtime.

Local managed development composes the public repository with development
implementations of these interfaces. A different operator can provide its own
services without forking the Kernel contract.

## Entitlements

Entitlements answer what an installation may use. Keys are strings such as
`inference.included` or `email.daily_messages`; values are booleans, numbers, or
strings. Missing keys mean the feature is not entitled.

Consumers may cache an entitlement snapshot until `refreshAfter`, normally for
five to fifteen minutes, but must not use it after `expiresAt`. Entitlements do
not replace strong usage accounting: inference, email, and other metered services
still own their reservations, counters, idempotency, and settlement.

## Adapters

Adapters are an extension system, not a closed list of messenger brands. An
adapter Worker implements `AdapterService` and returns an
`AdapterServiceDescriptor` describing its public name, supported lifecycle
operations, surface kinds, and media directions. The Gateway discovers adapter
bindings by their `CHANNEL_*` deployment identity and verifies that the returned
descriptor agrees with that trusted identity.

Telegram, WhatsApp, and Discord are bundled implementations. Matrix, Slack,
Signal, IRC, a game chat, or a future transport can implement the same contract
without adding a Kernel-specific RPC.

One Worker per trusted adapter implementation is the normal deployment boundary.
It keeps provider SDKs, webhooks, credentials, retries, and failures isolated;
adapter accounts or peers live in adapter-owned Durable Objects rather than one
Worker deployment per account.

A future third-party marketplace can place an adapter dispatcher behind one
trusted binding and run uploaded implementations in Workers for Platforms. That
dispatcher must enforce code provenance, secret grants, resource limits, and the
same `AdapterService` semantics. The public Gateway and standalone deployment do
not depend on that hosting product.
