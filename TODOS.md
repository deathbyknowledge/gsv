# GSV TODO List

## Overview

GSV (Gateway-Session-Vector) is a distributed AI agent platform built on Cloudflare Durable Objects. This document tracks features to implement, prioritized based on clawdbot feature parity and user needs.

---

## Feature Comparison: GSV vs Clawdbot

### Config Options

| Feature | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| Model settings | `model.provider`, `model.id` | Same | Done |
| API keys | Multiple providers | anthropic, openai, google | Done |
| Timeouts | Multiple | `llmMs`, `toolMs` | Done |
| System prompt | Yes | Yes | Done |
| Thinking levels | `off/minimal/low/medium/high/xhigh` | `none/low/medium/high` | Partial |
| Session scope | `per-sender`, `global` | - | Missing |
| DM scope | `main`, `per-peer`, `per-channel-peer` | Hardcoded `per-channel-peer` | Missing config |
| Identity links | Map platform IDs to canonical peers | - | Missing |
| Reset triggers | Configurable commands | Hardcoded | Missing |
| Typing indicators | `never/instant/thinking/message` | - | Missing |
| Message queue | `mode`, `debounce`, `cap`, `drop` | - | Missing |
| Auth profiles | Multiple API key profiles | Single keys | Lower priority |
| Verbose/reasoning | Multiple modes | - | Missing |
| Max tokens | Configurable | Session setting | Done |

### Slash Commands

| Command | Clawdbot | GSV | Priority |
|---------|----------|-----|----------|
| `/new` | Reset session | - | **High** |
| `/reset` | Reset session | - | **High** |
| `/stop` | Stop current run | - | **High** |
| `/compact` | Compact context | - | **Medium** |
| `/think` | Set thinking level | - | **Medium** |
| `/model` | Show/set model | - | **Medium** |
| `/status` | Show status | - | **Medium** |
| `/help` | Show commands | - | Low |
| `/verbose` | Toggle verbose | - | Low |
| `/usage` | Token/cost summary | - | Low |
| `/whoami` | Show sender ID | - | Low |

### Session Management

| Feature | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| Manual reset | Yes | Yes | Done |
| Daily reset | With configurable hour | Yes | Done |
| Idle reset | With configurable minutes | Yes | Done |
| Per-chat-type policies | `dm/group/thread` | - | Missing |
| Per-channel policies | Yes | - | Missing |
| Token tracking | Yes | Yes | Done |
| Session archival | Yes | Yes | Done |
| Session compact | Yes | Yes | Done |
| Session labels | Yes | Yes | Done |
| Previous session tracking | Yes | Yes | Done |
| Session preview | Yes | Yes | Done |

---

## High Priority

### 1. Slash Command Parsing

Parse commands in `channel.inbound` before sending to LLM.

**Commands to implement:**
- `/new` or `/reset` - Call `session.reset()`, respond with confirmation
- `/stop` - Cancel current run (need run tracking)
- `/compact [N]` - Call `session.compact(N)`, respond with result

**Implementation:**
- Add `parseSlashCommand(text)` helper in Gateway
- Check for commands before routing to Session
- Return command response directly to channel (don't invoke LLM)

```typescript
function parseSlashCommand(text: string): { command: string; args: string[] } | null {
  const match = text.trim().match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = match[2]?.split(/\s+/).filter(Boolean) ?? [];
  return { command, args };
}
```

**Files to modify:**
- `gateway/src/gateway.ts` - Add command parsing in `handleChannelInbound()`
- `gateway/src/types.ts` - Add command response types

---

### 2. WhatsApp Media/Voice Support

Support receiving and processing media messages from WhatsApp.

**Message types to handle:**
- Images with captions
- Audio messages (voice notes)
- Videos with captions
- Documents

**Implementation approach:**

#### 2.1 Download Media from WhatsApp
Baileys provides `downloadMediaMessage()` to get media buffer:
```typescript
import { downloadMediaMessage } from "@whiskeysockets/baileys";

const buffer = await downloadMediaMessage(msg, "buffer", {});
const mimeType = msg.message?.imageMessage?.mimetype;
```

#### 2.2 Store Media Temporarily
Options:
- **R2 bucket** - Upload to GSV's R2, get signed URL
- **Base64 inline** - For small files, embed in message (expensive)
- **Cloudflare Images** - For image processing

Recommended: R2 with signed URLs (1hr expiry)

#### 2.3 Transcribe Audio
For voice messages:
- Use Whisper API (OpenAI) or Cloudflare Workers AI
- Add transcription to message text

#### 2.4 Send to LLM
Format message with media:
```typescript
const content = [
  { type: "text", text: caption || "User sent an image:" },
  { type: "image", url: signedUrl, mediaType: mimeType },
];
```

**Files to modify:**
- `channels/whatsapp/src/whatsapp-account.ts` - Handle media in `handleMessagesUpsert()`
- `channels/whatsapp/src/types.ts` - Add media types
- `channels/whatsapp/wrangler.jsonc` - Add R2 binding
- `gateway/src/types.ts` - Extend `ChannelInboundParams` with media

**New files:**
- `channels/whatsapp/src/media.ts` - Media download, upload, transcription

---

### 3. Session Scope Configuration

Add configurable session scoping.

**Config options:**
```typescript
session: {
  scope: "per-sender" | "global";  // Default: "per-sender"
  dmScope: "main" | "per-peer" | "per-channel-peer";  // Default: "per-channel-peer"
  identityLinks?: Record<string, string[]>;  // Map identities to canonical peer
}
```

**Session key generation:**
- `global` → `agent:{agentId}:main`
- `per-sender` + `main` → `agent:{agentId}:main` (all DMs share session)
- `per-sender` + `per-peer` → `agent:{agentId}:dm:{peerId}`
- `per-sender` + `per-channel-peer` → `agent:{agentId}:{channel}:dm:{peerId}` (current)

**Files to modify:**
- `gateway/src/config.ts` - Add session config types
- `gateway/src/gateway.ts` - Use config in `buildSessionKeyFromChannel()`

---

## Medium Priority

### 4. Thinking Level Command

Add `/think` command to set thinking/reasoning level.

**Syntax:**
```
/think off|low|medium|high
```

**Implementation:**
- Update session settings via `session.patch()`
- Map to Claude's `thinking` parameter

**Files to modify:**
- `gateway/src/gateway.ts` - Add `/think` command handler
- `gateway/src/session.ts` - Pass thinking level to LLM

---

### 5. Model Command

Add `/model` command to view/change model.

**Syntax:**
```
/model              # Show current model
/model sonnet       # Set to claude-sonnet-4-20250514
/model gpt-4o       # Set to gpt-4o
```

**Implementation:**
- Update session settings
- Support model aliases (sonnet → claude-sonnet-4-20250514)

---

### 6. Status Command

Add `/status` command showing session info.

**Response includes:**
- Current model
- Token usage
- Message count
- Session age
- Reset policy

---

### 7. Stop Current Run

Add `/stop` command and run cancellation.

**Implementation:**
- Track current `runId` in session
- Add `session.abort(runId)` RPC method
- Cancel pending tool calls
- Send cancellation to LLM (if supported)

---

### 8. Per-Chat-Type Reset Policies

Allow different reset policies for DMs vs groups vs threads.

**Config:**
```typescript
session: {
  reset: { mode: "daily", atHour: 4 },  // Default
  resetByType: {
    dm: { mode: "idle", idleMinutes: 120 },
    group: { mode: "daily", atHour: 4 },
    thread: { mode: "manual" },
  }
}
```

---

## Lower Priority

### 9. Message Queue/Debouncing

Handle rapid message bursts gracefully.

**Config:**
```typescript
messages: {
  queue: {
    mode: "debounce" | "batch" | "drop";
    debounceMs: 500;
    maxBatch: 5;
  }
}
```

---

### 10. Typing Indicators

Send typing indicators while processing.

**Config:**
```typescript
session: {
  typingMode: "never" | "instant" | "thinking" | "message";
  typingIntervalSeconds: 5;
}
```

**Implementation:**
- Send `channel.typing` event to channel
- WhatsApp channel calls `sock.sendPresenceUpdate("composing", jid)`

---

### 11. Help Command

Add `/help` command listing available commands.

---

### 12. Usage/Cost Command

Add `/usage` command showing token usage and estimated cost.

---

### 13. Identity Links

Allow mapping cross-platform identities to single session.

**Config:**
```typescript
session: {
  identityLinks: {
    "steve": [
      "whatsapp:+1234567890",
      "telegram:12345678",
      "discord:steve#1234"
    ]
  }
}
```

All messages from linked identities share the same session.

---

## Completed Features

### Session Management
- [x] R2 bucket setup and storage helpers
- [x] Enhanced session state schema
- [x] Token tracking
- [x] Per-session settings
- [x] Session reset with archiving
- [x] Session stats/get RPC methods
- [x] Auto-reset policies (daily/idle)
- [x] Session compact
- [x] Session history
- [x] Session preview
- [x] CLI commands for session management

### WhatsApp Channel
- [x] Baileys integration with Workers shims
- [x] QR code login flow
- [x] Gateway channel connection
- [x] Message routing (inbound/outbound)
- [x] Keep-alive alarm to prevent hibernation
- [x] Bearer token auth for management API

### Gateway
- [x] Channel mode connection
- [x] `channel.inbound` / `channel.outbound` events
- [x] Session key generation (clawdbot-compatible format)
- [x] Channel registry

---

## Implementation Order

### Phase 1: Commands (Next)
1. [ ] Slash command parsing infrastructure
2. [ ] `/new` and `/reset` commands
3. [ ] `/stop` command with run cancellation
4. [ ] `/compact` command

### Phase 2: WhatsApp Media
5. [ ] Media download from WhatsApp
6. [ ] R2 storage for media
7. [ ] Audio transcription (Whisper)
8. [ ] Multi-modal message support

### Phase 3: Configuration
9. [ ] Session scope config
10. [ ] Thinking level command
11. [ ] Model command

### Phase 4: Polish
12. [ ] Status command
13. [ ] Help command
14. [ ] Typing indicators
15. [ ] Message queue/debouncing

---

## Notes

- Session key format: `agent:{agentId}:{channel}:{peerKind}:{peerId}` (matches clawdbot)
- Media files stored in R2 with signed URLs for LLM access
- Slash commands intercepted at Gateway, not sent to LLM
- Audio transcription adds latency - consider async processing
