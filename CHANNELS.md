# GSV Adapter Architecture

Messaging integrations are **adapters**. Some worker, binding, and deployment
names still contain `channel` for compatibility; that does not define a second
runtime abstraction.

The canonical architecture is [the adapter model](docs/architecture/adapter-model.md).
Its public contracts are documented in:

- [Syscalls](docs/reference/syscalls.md)
- [WebSocket protocol](docs/reference/websocket-protocol.md)
- [Routing](docs/reference/routing.md)

The implementation source of truth is:

- `gateway/src/adapter-interface.ts`
- `packages/gsv/src/protocol/adapters.ts`
- `packages/gsv/src/protocol/syscalls/adapter.ts`
- `packages/gsv/src/protocol/adapter-media-body.ts`

Platform identity, connection, media, and delivery quirks stay in the adapter.
Identity authorization, process routing, schedules, and inference coordination
stay in the Gateway.
