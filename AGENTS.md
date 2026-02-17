# GSV Agent Guidelines

GSV (General Systems Vehicle) is a distributed AI agent platform built on Cloudflare Workers + Durable Objects, with a Rust CLI for clients/nodes and standalone channel workers.

## Project Structure

```
gsv/
├── gateway/                    # Main Cloudflare worker (Gateway + Session DOs)
│   ├── src/
│   │   ├── gateway/do.ts       # Gateway DO (routing, config, tools, channels, cron, heartbeats)
│   │   ├── session/do.ts       # Session DO (agent loop + message state)
│   │   ├── agents/             # Workspace loading + prompt assembly + native tools
│   │   ├── cron/               # Cron scheduler + storage + tool input normalization
│   │   ├── protocol/           # Shared WS/RPC frame and payload types
│   │   ├── storage/            # R2 archives/media helpers
│   │   └── transcription/      # Audio transcription pipeline
│   ├── ui/                     # Web UI (Vite + TypeScript + Lit)
│   ├── alchemy/                # Infra and wizard deployment flows
│   ├── wrangler.jsonc          # Production worker config
│   └── wrangler.test.jsonc     # Unit-test worker config
├── channels/                   # Channel workers (each independently deployable)
│   ├── whatsapp/               # WhatsApp channel (Baileys + DO account state)
│   ├── discord/                # Discord channel (Gateway WS DO + REST send)
│   └── test/                   # Test channel for e2e/dev
├── cli/                        # Rust CLI (client, node daemon, deploy tooling)
│   ├── src/main.rs             # CLI command surface
│   ├── src/deploy.rs           # Cloudflare deploy/apply/down/status
│   ├── src/connection.rs       # WS connection + reconnect/request plumbing
│   ├── src/protocol.rs         # WS frame + payload types
│   └── src/tools/              # Node tool implementations (Bash/Read/Write/Edit/Glob/Grep)
├── templates/                  # Workspace and skill templates uploaded to R2
├── scripts/                    # Monorepo helper scripts
├── docs/                       # Design notes and workplans
├── README.md
└── CHANNELS.md
```

## Build & Development Commands

### Monorepo Bootstrap

```bash
# Installs JS deps (gateway, UI, channels) via bun
./scripts/setup-deps.sh

# Build deployable Cloudflare bundles into release/local (or custom dir)
./scripts/build-cloudflare-bundles.sh
./scripts/build-cloudflare-bundles.sh ./release/custom
```

### Gateway (TypeScript Worker)

```bash
cd gateway

# Local dev worker
npm run dev

# Type check
npx tsc --noEmit

# Regenerate worker env types
npm run cf-typegen

# Unit tests
npm test
npm run test:run

# e2e tests (bun:test in alchemy/e2e)
npm run test:e2e

# Alchemy-based deploy flows
npm run deploy:wizard
npm run deploy:up
npm run deploy:status
npm run deploy:destroy
```

### Gateway UI (`gateway/ui`)

```bash
cd gateway/ui
npm run dev
npm run build
npm run check
npm run preview
```

### Channel Workers

```bash
# WhatsApp
cd channels/whatsapp
npm run dev
npm run deploy
npm run cf-typegen

# Discord
cd channels/discord
npm run dev
npm run deploy
npm run typecheck

# Test channel
cd channels/test
npm run dev
npm run deploy
npm run typecheck
```

### CLI (Rust)

```bash
cd cli

# Build / test / format
cargo build
cargo build --release
cargo test
cargo fmt

# Common runtime commands
cargo run -- client "Hello"
cargo run -- node --foreground --id macbook --workspace ~/projects
cargo run -- node install --id macbook --workspace ~/projects
cargo run -- deploy up --wizard --all
cargo run -- session list
cargo run -- tools list
```

## Runtime Architecture Notes

- Gateway is the central control plane; Session DOs handle per-session agent state.
- Channels are separate workers. Outbound calls are Service Binding RPC (`CHANNEL_WHATSAPP`, `CHANNEL_DISCORD`, optional test channel).
- Inbound channel events flow through a shared queue (`GATEWAY_QUEUE` / `gsv-gateway-inbound`) and are consumed by the Gateway worker.
- Worker serves:
  - `GET /health` for health checks
  - `GET /ws` for websocket clients/nodes
  - `GET /media/...` for R2-backed media fetches
  - static UI assets (SPA fallback) when UI is deployed

## Code Style Guidelines

### TypeScript (Gateway + Channels + UI)

- 2-space indentation.
- Prefer double quotes and semicolons.
- Use trailing commas in multiline literals.
- Keep imports grouped: Cloudflare/runtime -> external packages -> local modules.
- Use `import type` for type-only imports.
- Keep `strict` typing (`any` only when unavoidable and tightly scoped).
- Prefer small, explicit payload types in `src/protocol/*` and `channel-interface.ts`.

### Rust (CLI)

- Use `rustfmt` defaults (`cargo fmt` before commit).
- Prefer `Result` + `?` for propagation.
- Add context to user-facing errors when crossing IO/network boundaries.
- Keep async logic on `tokio`; avoid blocking calls in async paths unless isolated.

## Durable Objects & Worker Patterns

- Gateway DO: websocket routing, config, node registry, tool dispatch, session lifecycle.
- Session DO: message history, model/tool loop, reset/archive flow.
- Persist DO state with `PersistedObject` (`gateway/src/shared/persisted-object.ts`) where mutable state must survive hibernation.
- Use alarms for scheduled behavior (heartbeats, retries, cron checks).
- Keep channel platform specifics isolated inside each channel worker.

## Protocol Frames

All websocket communication uses JSON frames:

```typescript
type Frame =
  | { type: "req"; id: string; method: string; params?: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: ErrorShape }
  | { type: "evt"; event: string; payload?: unknown; seq?: number };
```

## R2 Storage Layout

```text
gsv-storage/
├── agents/{agentId}/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   ├── MEMORY.md
│   ├── TOOLS.md
│   ├── HEARTBEAT.md
│   ├── BOOTSTRAP.md
│   ├── memory/{YYYY-MM-DD}.md
│   ├── sessions/{sessionId}.jsonl.gz
│   └── skills/{skillName}/SKILL.md
├── skills/{skillName}/SKILL.md         # Global skills
└── media/{sessionKey}/{uuid}.{ext}
```

## Key Dependencies

- Gateway: `wrangler`, `@mariozechner/pi-ai`, `alchemy`, `vitest`
- Gateway UI: `lit`, `vite`, `marked`, `dompurify`
- CLI: `tokio`, `tokio-tungstenite`, `reqwest`, `clap`, `serde_json`
- WhatsApp channel: `@whiskeysockets/baileys`, `qrcode`

## Commit Guidelines

- Short, imperative, lowercase commit subjects.
- Reference issue IDs when relevant.
- Examples:
  - `add channel status rpc handler`
  - `fix session reset archive metadata`
  - `update deploy queue consumer wiring`

## Security Notes

- Store secrets in Cloudflare Worker secrets or local config; never hardcode tokens.
- Do not log API keys, auth tokens, QR auth payloads, or raw credential blobs.
- Use `.dev.vars` for local worker secrets (gitignored).
