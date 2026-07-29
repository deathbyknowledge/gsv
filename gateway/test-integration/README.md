# Gateway integration tests

These tests boot the production `wrangler.jsonc` topology with Wrangler's test
harness and exercise the gateway through HTTP, WebSocket, service-binding, and
storage boundaries.

The first configured Worker is the real gateway. `gsv-test-dependencies`
replaces only external infrastructure: Ripgit, channel adapters, and Workers
AI. Keep those replacements deterministic and implement their public contracts
on the fixture's default `WorkerEntrypoint`; `bindingOverrides` targets that
default export.

Runtime tests configure a process-scoped custom model that talks to a local
OpenAI-compatible HTTP fixture. This exercises the production model transport,
stream parsing, Process loop, signal relay, history, and archival flow without
using credentials or a remote model. The dependency Worker also binds back to
`GatewayEntrypoint` so adapter ingress and automatic replies cross real service
bindings in both directions. Its test-only HTTP endpoints are drivers and
recorders; they are not gateway routes.

Prefer this suite for behavior visible to a gateway client or bound Worker.
Keep focused unit tests for pure policy, migrations, malformed input, and races
that cannot be driven deterministically through the public boundary. When an
integration scenario fully carries a mocked happy-path unit test's assertions,
delete the unit test.

Run the suite with:

```bash
npm run test:integration
```

The command builds `web/dist` first so static assets use the same production
configuration as a deployed gateway. All infrastructure is local; do not leave
an unoverridden Workers AI binding in the harness because Wrangler proxies that
binding remotely.
