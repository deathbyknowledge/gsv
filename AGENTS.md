# GSV Agent Guidelines

GSV (Gateway-Session-Vector) is a distributed AI agent platform built on Cloudflare Durable Objects.

## Project Structure

```
gsv/
├── gateway/               # Cloudflare Worker + Durable Objects (TypeScript)
│   ├── src/
│   │   ├── index.ts      # Worker entry, exports DOs
│   │   ├── gateway.ts    # Gateway DO - WebSocket routing, config, tool registry
│   │   ├── session.ts    # Session DO - agent loop, LLM calls, state
│   │   ├── storage.ts    # R2 storage helpers (archives, skills)
│   │   ├── config.ts     # GsvConfig types and defaults
│   │   ├── types.ts      # Protocol frame types
│   │   ├── stored.ts     # PersistedObject helper for DO storage
│   │   └── utils.ts      # WebSocket utilities
│   └── wrangler.jsonc    # Cloudflare Worker config
├── cli/                   # Rust CLI client/node
│   ├── src/
│   │   ├── main.rs       # CLI entry, subcommands
│   │   ├── connection.rs # WebSocket connection with reconnect
│   │   ├── protocol.rs   # Frame types matching gateway
│   │   └── tools/        # Tool implementations (bash, etc.)
│   └── Cargo.toml
├── SPEC.md               # Full protocol and architecture spec
└── TODOS.md              # Implementation roadmap
```

## Build & Development Commands

### Gateway (TypeScript/Cloudflare)

```bash
cd gateway

# Install dependencies
npm install

# Start local dev server (with hot reload)
npm run dev

# Type-check without emitting
npx tsc --noEmit

# Regenerate types from wrangler config
npm run cf-typegen

# Deploy to Cloudflare
npm run deploy
```

### CLI (Rust)

```bash
cd cli

# Build debug
cargo build

# Build release
cargo build --release

# Run directly
cargo run -- client "Hello"
cargo run -- node --id my-node
cargo run -- config get
cargo run -- session stats main

# Run tests (when added)
cargo test
cargo test test_name           # Single test
cargo test -- --nocapture      # Show println output
```

## Code Style Guidelines

### TypeScript (Gateway)

**Formatting:**
- 2-space indentation, tabs for alignment
- Double quotes for strings
- Semicolons required
- Trailing commas in multiline

**Imports:**
- Group: cloudflare → external packages → local modules
- Use `type` imports for types only: `import type { Foo } from "./types"`
- Explicit `.js` extensions not required (bundled by wrangler)

```typescript
import { DurableObject } from "cloudflare:workers";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import type { GsvConfig } from "./config";
import { PersistedObject } from "./stored";
```

**Types:**
- Strict mode enabled (`strict: true` in tsconfig)
- Avoid `any` - use `unknown` and narrow with type guards
- Export types from the file that defines them
- Use `type` for object shapes, `interface` for extendable contracts

```typescript
// Prefer type for fixed shapes
export type SessionState = {
  sessionId: string;
  messages: Message[];
};

// Use interface for DO class contracts
export interface Env {
  GATEWAY: DurableObjectNamespace;
  SESSION: DurableObjectNamespace;
  STORAGE: R2Bucket;
}
```

**Naming:**
- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE` for true constants
- DO classes: `PascalCase` (e.g., `Gateway`, `Session`)

**Error Handling:**
- Don't wrap everything in try/catch - let errors propagate
- Use try/catch only when you can meaningfully handle the error
- Log errors with context: `console.error(\`[Session] Failed: ${e}\`)`

**Durable Objects:**
- Use `PersistedObject` for state that survives hibernation
- Use WebSocket Hibernation API (`this.ctx.acceptWebSocket()`)
- Set alarms for timeouts: `this.ctx.storage.setAlarm(Date.now() + ms)`
- RPC between DOs: `const stub = this.env.SESSION.get(id); await stub.method()`

### Rust (CLI)

**Formatting:**
- `rustfmt` defaults (4-space indent)
- Run `cargo fmt` before committing

**Imports:**
- Group: std → external crates → local modules
- Use `use crate::` for local imports

```rust
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use crate::protocol::{Frame, RequestFrame};
```

**Error Handling:**
- Use `Result<T, Box<dyn std::error::Error>>` for simple cases
- Propagate errors with `?` operator
- Add context: `.map_err(|e| format!("Failed to connect: {}", e))?`

**Async:**
- Use `tokio` runtime (`#[tokio::main]`)
- Prefer `async fn` over manual futures
- Use `Arc<Mutex<T>>` for shared mutable state across tasks

## Cloudflare Workers Patterns

**wrangler.jsonc:**
```jsonc
{
  "compatibility_date": "2025-02-11",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "GATEWAY", "class_name": "Gateway" },
      { "name": "SESSION", "class_name": "Session" }
    ]
  }
}
```

**WebSocket Hibernation:**
```typescript
async fetch(request: Request): Promise<Response> {
  if (isWebSocketRequest(request)) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

webSocketMessage(ws: WebSocket, message: string) {
  // Handle incoming messages
}

webSocketClose(ws: WebSocket) {
  // Cleanup
}
```

**DO Storage:**
```typescript
// Use PersistedObject for reactive state
state = PersistedObject<SessionState>(this.ctx.storage.kv, {
  prefix: "state:",
  defaults: { messages: [], tokens: 0 },
});

// Direct mutation auto-persists
this.state.messages = [...this.state.messages, newMsg];
```

## Protocol & Frame Types

All WebSocket communication uses JSON frames:

```typescript
type Frame =
  | { type: "req"; id: string; method: string; params?: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: ErrorShape }
  | { type: "evt"; event: string; payload?: unknown };
```

## R2 Storage Structure

```
gsv-storage/
├── agents/{agentId}/
│   └── sessions/
│       └── {sessionId}.jsonl.gz    # Archived transcripts
└── skills/{skillName}/
    └── SKILL.md                    # Skill markdown (clawdbot format)
```

## Key Dependencies

**Gateway:**
- `@mariozechner/pi-ai` - Multi-provider LLM client
- `wrangler` - Cloudflare development/deployment

**CLI:**
- `tokio` - Async runtime
- `tokio-tungstenite` - WebSocket client
- `clap` - CLI argument parsing
- `serde_json` - JSON serialization

## Commit Guidelines

- Short, imperative, lowercase messages
- Reference issue numbers when applicable
- Examples: `add session compact`, `fix token tracking`, `update storage paths`

## Security Notes

- API keys stored in Cloudflare Secrets, accessed via `env`
- Never log API keys or sensitive data
- Use `.dev.vars` for local secrets (gitignored)
