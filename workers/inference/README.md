# Inference execution service

This Worker executes text and media requests for the gateway through
`InferenceExecutionService`. It uses the public runtime in `packages/inference`
and has no dependency on H&M accounts, pricing, or funding tables.

`INSTALLATION_DIRECTORY` resolves immutable installation identities through
Accounts. The service requires an active installation before addressing an
executor; the executor checks again before every admission. Each installation
has one SQLite `InferenceExecutor` in `INFERENCE_EXECUTORS`. Cancellation and
settlement remain available after an installation becomes restricted.

The gateway supplies transient provider credentials and, when selected by the
user, a request-scoped machine transport. `AI` provides native Workers AI. The
reference configuration routes `gsv/default` to the configured
`INFERENCE_DEFAULT_PROVIDER` and `INFERENCE_DEFAULT_MODEL`. An operator may set
the `INFERENCE_API_KEY` secret and optional `INFERENCE_BASE_URL` for that default
route. Other connections use the gateway-authorized credentials and endpoint.

The reference limits are configurable Worker variables:

| Variable | Default |
| --- | ---: |
| `INFERENCE_MONTHLY_REQUESTS` | 10,000 |
| `INFERENCE_MONTHLY_OUTPUT_TOKENS` | 1,000,000 |
| `INFERENCE_MAX_OUTPUT_TOKENS` | 32,768 |
| `INFERENCE_MAX_DURATION_MS` | 180,000 |

Months use UTC. Admission atomically reserves the requested output budget and
increments the request count. Completed text reports actual output tokens.
An explicit zero disables either monthly quota. Per-request token and duration
limits must remain positive. The private composition explicitly disables the
monthly operational quotas and retains its existing commercial funding policy.
Cancellation, deadline expiry, or restart without final usage consumes the
reservation conservatively. Media counts as a request; image reading also
reserves its text output budget. Other media has no text token reservation.
Audio input is capped at 25 MiB and image input at 10 MiB; a caller can lower
those limits.

The effective deadline is the earliest of the gateway deadline, the request
timeout, and the operator maximum. The executor owns provider bodies and the
transport capability through completion or cancellation. The first terminal
reason wins, including aborts that arrive before generation. Completed request
identities cannot be replayed. Request metadata and cancellation tombstones are
retained until 24 hours after the deadline; an old request's expired deadline
still prevents execution after metadata expiry. Alarms release expired
reservations and prune metadata. A restart marks active requests interrupted
and never replays provider execution.

Durable state contains request identities, local actor IDs, terminal states,
timings, and usage counters. Prompts, credentials, provider responses, and media
bytes are never persisted there. The private service composes this same executor
with its funded provider factory; its existing funded installation store keeps
commercial reservations and settlement independently.

Run `npm run typecheck --workspace workers/inference` and
`npm test --workspace workers/inference` for the Worker. Its RPC tests cover two
installation scopes, directory admission, quotas, streaming, selected-target
transport, cancellation, media bodies, restart, and expiry. Test bindings are
local fakes and do not call a live provider.
