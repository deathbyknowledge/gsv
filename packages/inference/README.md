# Shared inference execution

This package owns the Workers AI execution path used by GSV inference services:
provider request construction, streamed results, truthful response-model
attribution, generation deadlines, first-output fallback, cancellation and late
body cleanup. Both a public reference service and an operator's funded service
use this implementation so reliability fixes land once.

`createWorkersAiGeneration` accepts a validated installation-scoped request and
an operator's AI binding. The caller supplies model routing and observes attempt
outcomes; this package does not choose prices, grant funding, reserve credit,
charge customers or write usage records. Its only model/cost fixtures are test
data. The provider integration keeps the existing `default` AI Gateway and
pi-ai 0.84.2 during this extraction.

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
