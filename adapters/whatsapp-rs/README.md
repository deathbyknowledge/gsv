# GSV WhatsApp Rust Adapter Spike

This is the `workers-rs` implementation of the WhatsApp adapter. The local
multi-worker dev stack points `CHANNEL_WHATSAPP` at this worker so it can be
tested end-to-end through the gateway.

The first milestone is a Worker/Durable Object skeleton with the same account
HTTP routes as `adapters/whatsapp`:

- `GET /health`
- `GET /accounts`
- `GET /account/:accountId/status`
- `POST /account/:accountId/login`
- `POST /account/:accountId/logout`
- `POST /account/:accountId/wake`
- `POST /account/:accountId/stop`
- `POST /account/:accountId/send`
- `POST /account/:accountId/react`
- `POST /account/:accountId/typing`

The production gateway currently uses WorkerEntrypoint RPC methods such as
`adapterConnect`, `adapterSend`, and `adapterShellExec`. This spike exports
those methods from Rust with `#[wasm_bindgen]` and uses a small local
`worker-build` shim so gateway RPC calls pass `this.env` into the Rust exports.
The exports forward into the per-account Durable Object through the
`WHATSAPP_ACCOUNT` binding. The shim exports both the default entrypoint and a
`WhatsAppChannelEntrypoint` named entrypoint so the gateway's existing WhatsApp
service-binding shape can be pointed at this worker for e2e testing.

## Intended shape

- `src/types.rs`: DTOs matching the existing TypeScript adapter contract.
- `src/rpc.rs`: Gateway-facing adapter RPC method exports and DO forwarding.
- `src/account.rs`: one Durable Object per WhatsApp account.
- `src/schema.rs`: DO SQLite schema for account metadata and future
  `whatsapp-rust` backend state.
- `src/whatsapp_client.rs`: boundary for the WhatsApp Rust client integration.
- `src/worker-rpc-shim.js`: adapter-local `worker-build` shim that injects
  `this.env` into adapter RPC exports.

## Library choice

The upstream `whatsapp-rust = 0.6.0` crate currently requires nightly Rust
because `wacore` uses an unstable `if let` match guard. This spike pins a local
nightly toolchain for `adapters/whatsapp-rs` and includes `whatsapp-rust` with
default runtime/storage/transport features disabled.

The `wa-rs = 0.2.0` stable fork was also tested, but it currently fails a
`wasm32-unknown-unknown` check because several async signal-store impls require
`Send` futures while the underlying traits do not.

## Build

```bash
cd adapters/whatsapp-rs
cargo check --target wasm32-unknown-unknown
```

For a Worker build:

```bash
cd adapters/whatsapp-rs
npm run build:worker
```

For a local deployability check:

```bash
cd adapters/whatsapp-rs
npx wrangler deploy --dry-run
```

To test through the gateway, run the root `npm run dev` script. The existing
`entrypoint = "WhatsAppChannelEntrypoint"` shape is supported by the Rust shim.
