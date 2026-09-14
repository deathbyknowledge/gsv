# Delayed inference: local stream lifetime prerequisite

This acceptance-only relay checks whether a real workerd RPC response stream can
remain held while its caller cancels, then reject a release through the same
original writer. It is not a cloud teardown test and makes no provider call.

Run from the repository root:

```sh
npx vitest run deployment/test/delayed-inference-relay.test.ts
npx vitest run deployment/test/delayed-physical-probe.test.ts
npx tsc --noEmit -p deployment/acceptance/delayed-inference/tsconfig.json
```

The local fixture has a caller Durable Object, an independent controller Durable
Object, the relay Durable Object, and an upstream Worker RPC target. The upstream
returns a fixed terminal-success event. The caller owns and cancels the transferred inference
reader inside workerd, matching GSV's ownership boundary. The controller holds a
separate control stream throughout the attempt.

The tests cover:

- A connected caller receives exactly the captured upstream bytes; one upstream
  generation occurs and no abort is invented.
- Cancelling the original caller reader leaves the relay's original writer and
  captured digest intact. A later release writes to that writer and the stream
  rejects. No new generation occurs and the caller receives zero bytes.
- The caller's actual `abort(requestId, "cancelled")` reaches its original
  upstream target. Content-free receipt metadata records observation and
  forwarding times alongside the original request deadline.
- Losing the independent control lease makes the attempt inconclusive. Its
  synthetic cleanup cannot be reported as successful cancellation by GSV.

There is no retirement flag, custom stale-result rejection, reconstructed writer,
or new generation in the release path. The original writer and captured bytes
exist only in memory. Only the receipt is persisted; restarting its owner marks
an unfinished attempt inconclusive.

Quiet RPC streams may observe a disconnected reader only on their next write.
The control stream therefore sends a small heartbeat. `cancellationObservedAt`
describes when the relay's writer observes closure, which may be during release;
it is not the time when the caller decided to cancel. `abort.observedAt` and
`abort.forwardedAt` record the actual executor-abort RPC separately.

The `DelayedControl` entrypoint requires the deployment-owned
`delayed-inference-acceptance` authority. The relay's ordinary HTTP surface
returns 404. The local probe's HTTP controls are deliberately unauthenticated and
must not be deployed.

The authenticated controller now owns a bounded HTTP control lease. Before
provider dispatch the relay exposes the actual pending request ID for its exact
configured installation and Process affinity. An operator must confirm that ID;
an unconfirmed admission expires without dispatch. Capture accepts one terminal
success only from the configured provider/model with nonzero output usage.
All eight local tests use synthetic upstream data; real native success remains a
cloud acceptance requirement.

Explicit executor, duplicate and returned-stream handles are disposed. Tests
prove that reusing the disposed handle fails. A separate direct-upstream local
probe showed that the remote target destructor callback remains deferred in a
retained Durable Object execution context, even without this relay; its timing
is not used as a resource-erasure assertion.

Cloud reset/deletion/inventory, physical non-resurrection, control-space checks,
and cleanup of the relay's captured bytes remain separate. The local tests do
not establish those facts. This is a fixture-specific acceptance tool, not a
general-purpose replacement for the inference service.

For cloud acceptance, the authenticated controller also exposes `/physical`.
Deployment fixes the original installation, deletion operation, resource names,
physical addresses and five owner namespace bindings before inference starts.
Store `PHYSICAL_SCOPE` as serialized JSON text; the probe parses it once before
strict validation. This keeps deployment-library field-name conversion from
rewriting names inside the opaque scope.
The request can only repeat the installation and operation; it cannot choose an
address. The controller reads existing owner inspection methods directly, so a
cached directory discovery receipt cannot stand in for a fresh storage check.
Kernel, Process, Conversation and repository observations cover application
storage, excluding retained identity and retirement tombstones. The executor
observation requires retirement for the exact operation and checks its remaining
request, usage and active-operation counts. Responses contain counts and hashed
names, never application content.

The cloud driver must compare that complete fixed scope with the captured
deletion inventory, verify the actual deployed namespace bindings, and list the
retired R2 prefix separately. Repeat these checks before releasing the original
writer, after release, and after a bounded quiet period. Do not redeploy the
controller or relay during the held request: losing its original execution
makes the result inconclusive. These reads establish live application erasure;
provider logs, backups and other retained copies keep their separately reported
status.

RPC lifetime and ownership references:

- <https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/>
- <https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writablestream-request-and-response>
