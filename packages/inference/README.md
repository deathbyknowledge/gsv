# Shared inference execution

This package owns the execution path used by GSV inference services:
provider request construction, streamed results, truthful response-model
attribution, generation deadlines, first-output fallback, cancellation and late
body cleanup. Both a public reference service and an operator's funded service
use this implementation so reliability fixes land once.

`createInferenceGeneration` accepts a validated installation-scoped request and
a transport selector for each explicitly routed model. The transport supplies
its fetch implementation and pi-ai stream; the shared loop still owns deadlines,
first-output fallback, cancellation, attempt observation and result projection.
It never invents another provider or retries after exposing output.

`createWorkersAiGeneration` remains the AI-binding wrapper over that same loop.
Its `createWorkersAiTransport` adapter can be composed with operator-owned
transports without changing Gateway or client contracts. The caller supplies model routing and observes attempt
outcomes; this package does not choose prices, grant funding, reserve credit,
charge customers or write usage records. Its only model/cost fixtures are test
data. The Workers AI integration keeps the existing `default` AI Gateway.

The binding attaches UTF-8 request size and a fixed projection of message,
tool and image counts to AI Gateway metadata for JSON requests. This projection
contains no prompt, response, tool argument, tool name or image data. Request
and response streams remain owned by the transport; payload logging stays off.

The public types use neutral names while retaining the current SDK wire contract
and diagnostic text for rolling consumers. H&M still owns its funded admission,
pricing decisions, durable reservations and usage reconciliation. Its Worker
binding and Durable Object tests exercise this package as a dependency; shared
execution tests run here in both public and private CI.

This is an execution component, not yet the complete optional reference Worker.
Installation-scoped request persistence, basic reference limits, reference
service configuration and lifecycle cleanup remain to be extracted behind their
public contracts. No H&M resource or database migration accompanies this move.

Run `npm run typecheck --workspace @humansandmachines/gsv-inference` and
`npm test --workspace @humansandmachines/gsv-inference` from the repository root.
