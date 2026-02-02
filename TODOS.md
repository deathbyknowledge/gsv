# GSV TODO List

## Overview

GSV (Gateway-Session-Vector) is a distributed AI agent platform built on Cloudflare Durable Objects. This document tracks features to implement, prioritized based on clawdbot feature parity and user needs.

---

## Completed Features

### Slash Commands (Done!)
- [x] Command parsing infrastructure (`gateway/src/commands.ts`)
- [x] Directive parsing (`gateway/src/directives.ts`)
- [x] `/new` and `/reset` - Reset session
- [x] `/compact [N]` - Compact to last N messages
- [x] `/stop` - Stop command (placeholder, needs run cancellation)
- [x] `/status` - Show session info
- [x] `/model [name]` - Show/set model with aliases
- [x] `/think [level]` - Set thinking level
- [x] `/help` - Show available commands
- [x] Inline directives (`/think:high`, `/model:opus`)
- [x] Commands work in both `channel.inbound` AND `chat.send`
- [x] CLI updated to handle command responses

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
- [x] Image support (download, R2 storage, send to LLM)
- [x] Voice message transcription (Workers AI Whisper)
- [x] Custom media decryption (Workers-compatible, no Node.js streams)

### Gateway
- [x] Channel mode connection
- [x] `channel.inbound` / `channel.outbound` events
- [x] Session key generation (clawdbot-compatible format)
- [x] Channel registry
- [x] Auth token support (`auth.token` config)

### Agent Workspace (Phase 1 Done!)
- [x] Workspace loading from R2 (`gateway/src/workspace.ts`)
- [x] `loadAgentWorkspace()` - Loads AGENTS.md, SOUL.md, USER.md, MEMORY.md, TOOLS.md
- [x] `buildSystemPromptFromWorkspace()` - Combines files into system prompt
- [x] Daily memory loading (today + yesterday)
- [x] Main session security (`isMainSession()`) - MEMORY.md only in DMs/CLI
- [x] Template workspace files uploaded for `main` agent

---

## Remaining TODOs

### Critical: Heartbeat & Channel Security (clawdbot parity)

These items are required for a production-ready heartbeat system that matches clawdbot's behavior.

#### 1. WhatsApp Allowlist Filtering (SECURITY) ✅ DONE
**Status:** Implemented

- Added `channels.whatsapp.dmPolicy` ("open" | "allowlist")
- Added `channels.whatsapp.allowFrom` array
- Messages from non-allowed senders are silently blocked
- E164 normalization handles both `+31628552611` and `31628552611@s.whatsapp.net`

**Usage:**
```bash
gsv config set channels.whatsapp.dmPolicy allowlist
gsv config set channels.whatsapp.allowFrom '["+31628552611"]'
```

---

#### 1b. Pairing Flow (Enhancement) ✅ DONE
**Status:** Implemented

- Added `dmPolicy: "pairing"` option (default)
- Pending pairing requests stored in `PersistedObject<Record<string, PendingPair>>`
- Unknown senders get "awaiting approval" message
- CLI commands: `gsv pair list`, `gsv pair approve`, `gsv pair reject`
- On approval: adds to `allowFrom`, sends confirmation message to user
- Fixed WhatsApp LID JID handling: uses original JID for replies, senderPn for allowlist

**Usage:**
```bash
gsv config set channels.whatsapp.dmPolicy pairing
gsv pair list
gsv pair approve whatsapp +31649988417
```

---

#### 2. Last Active Channel Tracking ✅ DONE
**Status:** Implemented

- Gateway tracks `lastActiveContext[agentId]` with channel, accountId, peer, sessionKey, timestamp
- Updated on every inbound message
- Visible in `gsv heartbeat status`
- Heartbeat uses these to resolve delivery target

**Implementation:**
1. Add `lastActiveContext` to Gateway persisted state:
   ```typescript
   lastActiveContext: {
     agentId: string;
     channel: "whatsapp" | "cli" | etc;
     accountId: string;
     peer: PeerInfo;
     timestamp: number;
   } | null;
   ```
2. Update in `handleChannelInbound()` after successful routing
3. Expose via `heartbeat.status` for debugging

**Files to modify:**
- `gateway/src/gateway.ts` - Add `lastActiveContext` state, update on inbound

---

#### 3. Fix Heartbeat to Deliver Responses
**Priority:** High - Heartbeat runs but responses go nowhere

**Problem:** Current heartbeat uses isolated session `agent:main:heartbeat:system:internal`. This session:
- Has no connected WebSocket clients
- Has no `pendingChannelResponses` entry
- Response gets logged but not delivered

**Clawdbot approach:**
- Heartbeat runs in the **main session** (`agent:main:main`)
- Uses `lastChannel`/`lastTo` from session to route response
- Strips `HEARTBEAT_OK` token from response
- Suppresses short acks (< 300 chars)
- Deduplicates repeated responses within 24h

**Implementation:**
1. Change heartbeat session key from `agent:{agentId}:heartbeat:system:internal` to `agent:{agentId}:main` (or configurable)
2. After agent responds, check if it's a heartbeat run:
   - If response contains `HEARTBEAT_OK` and is short, suppress delivery
   - Otherwise, use `lastActiveContext` to route to channel
3. Add heartbeat tracking in session:
   ```typescript
   lastHeartbeatText?: string;
   lastHeartbeatSentAt?: number;
   ```
4. Skip delivery if same text within 24h (dedupe)

**Files to modify:**
- `gateway/src/gateway.ts` - Change heartbeat session, add delivery routing
- `gateway/src/heartbeat.ts` - Add response filtering logic
- `gateway/src/session.ts` - Add heartbeat tracking fields

---

#### 4. Heartbeat Skip Optimizations
**Priority:** Medium - Saves API costs

**Clawdbot optimizations we should add:**
1. **Empty HEARTBEAT.md** - If file only has comments/headers, skip LLM call
2. **Outside active hours** - Skip if outside configured hours (e.g., 08:00-22:00)
3. **Queue busy** - Skip if other requests are in flight (needs queue system)

**Implementation:**
1. In `runHeartbeat()`, read HEARTBEAT.md from R2 first
2. Check if content is "effectively empty" (only `#` headers, empty lines)
3. Check `activeHours` config before running
4. Return early with `{ skipped: true, reason: "..." }`

**Files to modify:**
- `gateway/src/gateway.ts` - Add skip checks in `runHeartbeat()`
- `gateway/src/config.ts` - Add `activeHours` to HeartbeatConfig

---

#### 5. Message Queue System
**Priority:** Medium - Prevents race conditions, enables heartbeat skip

**Problem:** If user sends multiple messages rapidly, or heartbeat fires while user message is processing, we get race conditions.

**Clawdbot approach:**
- Command queue with lanes (Main, Background)
- Heartbeat skips if queue has items ("requests-in-flight")
- Messages processed sequentially per session

**Implementation (simple approach):**
1. Add to Session DO:
   ```typescript
   pendingMessages: Array<{ text: string; runId: string; media?: MediaAttachment[] }> = [];
   isProcessing: boolean = false;
   ```
2. In `chatSend()`:
   - If `isProcessing`, push to queue and return `{ queued: true }`
   - Otherwise, set `isProcessing = true`, run agent loop
   - After completion, check queue and process next
3. In Gateway, expose queue size for heartbeat skip check

**Files to modify:**
- `gateway/src/session.ts` - Add queue logic to `chatSend()`
- `gateway/src/gateway.ts` - Check queue before heartbeat

---

#### 5b. Identity Links (Cross-Channel Session Routing)
**Priority:** Medium - Useful for multi-platform users

**Problem:** If the same person messages from WhatsApp AND Telegram, they get separate sessions with separate context. Identity links would route both to a single session.

**Clawdbot approach:**
```yaml
session:
  identityLinks:
    steve:
      - "+31628552611"           # WhatsApp number
      - "telegram:123456789"     # Telegram user ID
      - "whatsapp:+34675706329"  # Another WhatsApp number
```

With this config, messages from any of these identities route to `agent:main:steve` instead of separate per-channel sessions.

**Implementation:**
1. Add to GsvConfig:
   ```typescript
   session?: {
     identityLinks?: Record<string, string[]>;  // canonical -> [channel:id, ...]
   };
   ```
2. In `buildSessionKeyFromChannel()`:
   - Check if sender matches any identity link
   - If match found, use canonical name in session key: `agent:{agentId}:{canonical}`
   - If no match, use existing per-channel-peer format
3. Helper function `resolveLinkedIdentity(config, channel, peerId) -> string | null`

**Files to modify:**
- `gateway/src/config.ts` - Add identityLinks to config
- `gateway/src/gateway.ts` - Update session key resolution

---

#### 6. Inject HEARTBEAT.md into System Prompt
**Priority:** Medium - Agent can see heartbeat instructions

**Current state:** Workspace loading includes SOUL.md, AGENTS.md, etc. but not HEARTBEAT.md.

**Implementation:**
1. In `loadAgentWorkspace()`, also load `HEARTBEAT.md`
2. In `buildSystemPromptFromWorkspace()`, include heartbeat section (only for heartbeat runs or always?)
3. Alternative: Agent reads it via file tools when prompted

**Decision needed:** Always inject, or only inject during heartbeat runs?

**Files to modify:**
- `gateway/src/workspace.ts` - Load HEARTBEAT.md
- `gateway/src/session.ts` - Pass heartbeat context flag

---

### High Priority

#### 7. PDF/Document Support
PDFs and documents are downloaded and stored in R2, but not sent to the LLM.

**Current state:**
- WhatsApp channel downloads documents via custom Workers-compatible decryption
- Documents stored in R2 with `type: "document"`
- `buildUserMessage()` only processes images and audio, ignores documents

**Implementation:**
1. Add document handling in `session.ts` `buildUserMessage()`
2. Format as Anthropic `document` content block (base64 PDF)
3. Consider text extraction fallback for non-Anthropic providers

**Files to modify:**
- `gateway/src/session.ts` - Add document handling in `buildUserMessage()`

#### 2. Video Support
Videos are downloaded but not sent to LLM (similar to documents).

**Implementation:**
- Could extract frames and send as images
- Or wait for native video support in LLM APIs

#### 9. Run Cancellation (`/stop`)
Currently `/stop` is a placeholder. Need to implement actual run cancellation.

**Implementation:**
- Track current `runId` in Session
- Add `session.abort(runId)` RPC method
- Cancel pending tool calls
- Clean up partial state

#### 10. Thinking Level Actually Used
The `/think` command sets `thinkingLevel` in session settings, but it's not passed to the LLM yet.

**Implementation:**
- Pass thinking level to `completeSimple()` options
- Map levels to Claude's extended thinking parameters

---

### Medium Priority

#### 11. Session Scope Configuration
Add configurable session scoping.

```typescript
session: {
  scope: "per-sender" | "global";
  dmScope: "main" | "per-peer" | "per-channel-peer";
}
```

#### 12. Per-Chat-Type Reset Policies
Different reset policies for DMs vs groups.

```typescript
session: {
  resetByType: {
    dm: { mode: "idle", idleMinutes: 120 },
    group: { mode: "daily", atHour: 4 },
  }
}
```

#### 13. Typing Indicators
Send typing indicators while processing.

- Gateway sends `channel.typing` event
- WhatsApp channel calls `sock.sendPresenceUpdate("composing", jid)`

#### 14. `/usage` Command
Show detailed token usage and estimated cost.

---

### Lower Priority

#### 15. Message Debouncing
Handle rapid message bursts gracefully.

```typescript
messages: {
  queue: { mode: "debounce", debounceMs: 500 }
}
```

#### 16. `/verbose` Command
Toggle verbose mode for debugging.

#### 17. `/whoami` Command
Show sender ID and channel info.

#### 18. Identity Links
See section 5b above for detailed implementation plan.

---

## Feature Comparison: GSV vs Clawdbot

### Slash Commands

| Command | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| `/new`, `/reset` | Reset session | ✅ | Done |
| `/compact` | Compact context | ✅ | Done |
| `/stop` | Stop current run | ⚠️ | Placeholder |
| `/status` | Show status | ✅ | Done |
| `/model` | Show/set model | ✅ | Done |
| `/think` | Set thinking level | ✅ | Done (not wired to LLM) |
| `/help` | Show commands | ✅ | Done |
| `/verbose` | Toggle verbose | ❌ | TODO |
| `/usage` | Token/cost summary | ❌ | TODO |
| `/whoami` | Show sender ID | ❌ | TODO |

### Config Options

| Feature | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| Model settings | ✅ | ✅ | Done |
| API keys | ✅ | ✅ | Done |
| Timeouts | ✅ | ✅ | Done |
| System prompt | ✅ | ✅ | Done |
| Thinking levels | ✅ | ⚠️ | Command done, not wired |
| Session scope | ✅ | ❌ | TODO |
| DM scope | ✅ | Hardcoded | TODO config |
| Typing indicators | ✅ | ❌ | TODO |
| Message queue | ✅ | ❌ | TODO |
| Auth token | ✅ | ✅ | Done |

### Session Management

| Feature | Clawdbot | GSV | Status |
|---------|----------|-----|--------|
| Manual reset | ✅ | ✅ | Done |
| Daily reset | ✅ | ✅ | Done |
| Idle reset | ✅ | ✅ | Done |
| Per-chat-type policies | ✅ | ❌ | TODO |
| Token tracking | ✅ | ✅ | Done |
| Session archival | ✅ | ✅ | Done |
| Session compact | ✅ | ✅ | Done |

---

## Implementation Order

### Immediate (Heartbeat & Security) - DONE ✅
1. [x] **Allowlist filtering** - Security first! Stop random people from using the bot
2. [x] **Last active tracking** - Track where user last messaged from
3. [x] **Fix heartbeat delivery** - Route responses to last active channel
4. [x] **Pairing flow** - Let unknown senders request access, approve via CLI

### High Priority
5. [ ] **Identity links** - Route multiple channel identities to single session
6. [ ] **Heartbeat skip optimizations** - Empty file, active hours
7. [ ] **Message queue** - Prevent race conditions

### Next Up
8. [ ] PDF/document support in `buildUserMessage()`
9. [ ] Run cancellation for `/stop`
10. [ ] Typing indicators
11. [ ] Inject HEARTBEAT.md into system prompt

### Later
12. [ ] Video support (frame extraction?)
13. [ ] Session scope config
14. [ ] `/usage` command
15. [ ] Message debouncing
16. [ ] Sticker support (treat as images)

---

## Agent Framework (Clawdbot Parity)

The core agent loop is done. Now we need the **agent identity and memory system** that makes agents persistent entities rather than stateless chatbots.

### Agent Workspace

Each agent needs a workspace directory in R2:

```
gsv-storage/
└── agents/{agentId}/
    ├── AGENTS.md       # Operating instructions (read every session)
    ├── SOUL.md         # Identity/personality (read every session)  
    ├── USER.md         # Info about the human
    ├── MEMORY.md       # Long-term curated memory (main session only)
    ├── TOOLS.md        # Local tool notes
    ├── HEARTBEAT.md    # Proactive check instructions
    ├── memory/
    │   └── YYYY-MM-DD.md   # Daily notes
    ├── sessions/
    │   └── {sessionId}.jsonl.gz   # Archived transcripts
    └── skills/
        └── {skillName}/
            └── SKILL.md   # Skill definitions
```

**Implementation:**
- [x] **1. Workspace loading** - Session reads AGENTS.md + SOUL.md + USER.md from R2 at start
- [x] **2. System prompt injection** - Combine workspace files into system prompt
- [x] **3. Daily memory loading** - Auto-load `memory/YYYY-MM-DD.md` (today + yesterday)
- [x] **4. MEMORY.md security** - Only load in "main session" (direct DM with owner)
- [x] **5. File tools in CLI** - Read, Write, Edit, Glob, Grep tools with workspace support
- [x] **6. `gsv mount` command** - Mount R2 to local workspace via rclone FUSE

### Multi-Agent Support

```typescript
// Config schema
agents: {
  list: [
    { id: "main", default: true },
    { id: "work", model: { provider: "anthropic", id: "claude-opus" } },
    { id: "research", systemPrompt: "You are a research assistant..." }
  ]
}

// Bindings map channels/chats to agents  
bindings: [
  { agentId: "work", match: { channel: "slack", accountId: "T123" } },
  { agentId: "research", match: { channel: "telegram", peer: { kind: "dm", id: "456" } } }
]
```

**Implementation:**
- [ ] **6. Agent config schema** - Add `agents.list[]` and `bindings[]` to config
- [ ] **7. Agent resolution** - Gateway resolves agentId from channel/peer match
- [ ] **8. Per-agent settings** - Model, system prompt, workspace path per agent
- [ ] **9. Agent isolation** - Each agent has separate workspace in R2

### Skills System (DONE!)

Skills are markdown files that provide context and instructions. The agent sees a list of available skills in its system prompt and reads the SKILL.md on-demand.

**Implemented:**
- [x] Skills loading from R2 (`agents/{agentId}/skills/*/SKILL.md`)
- [x] Global skills support (`skills/*/SKILL.md`)
- [x] YAML frontmatter parsing (name, description, always)
- [x] Skills list injected into system prompt
- [x] On-demand reading via `Read` tool

```yaml
# skills/web-search/SKILL.md
---
name: web-search
always: true
requires:
  env: [SERP_API_KEY]
---
# Web Search

Use web_search tool to find current information...
```

**Remaining:**
- [ ] **Skill eligibility** - Check `requires` conditions (env vars, tools)

### Heartbeat/Proactive Behavior

Agents should be able to check in periodically:

- [ ] **Heartbeat polls** - Scheduled messages that trigger agent to check HEARTBEAT.md
- [ ] **Proactive actions** - Agent can send messages without user prompting
- [ ] **Cron jobs** - Scheduled tasks with isolated sessions

### Implementation Order

**Phase 1: Basic Workspace (DONE!)**
1. ✅ Workspace loading (AGENTS.md, SOUL.md, USER.md, TOOLS.md)
2. ✅ System prompt injection from workspace files
3. ✅ Daily memory loading (today + yesterday)
4. ✅ Main session security for MEMORY.md
5. ✅ File tools in CLI (Read, Write, Edit, Glob, Grep)
6. ✅ `gsv mount` command for R2 FUSE mount
7. ✅ Skills loading and injection

**Phase 2: Multi-Agent**
- Agent config schema
- Agent resolution from bindings
- Per-agent workspaces

**Phase 3: Proactive**
- Heartbeat system
- Cron jobs

---

## Notes

- Session key format: `agent:{agentId}:{channel}:{peerKind}:{peerId}` (matches clawdbot)
- Commands parsed at Gateway for ALL entry points (channel.inbound + chat.send)
- Architecture is distributed (better than clawdbot's monolithic approach)
- Media files will be stored in R2 with signed URLs for LLM access
- Agent workspaces live in R2, mountable locally via `gsv mount` (rclone FUSE)
- Default workspace path: `~/gsv/` (configurable via `--workspace` or `GSV_WORKSPACE`)
- CLI file tools (Read, Write, etc.) resolve paths relative to workspace
