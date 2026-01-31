# GSV: Gateway-Session-Vector Architecture

> A distributed AI agent system built on Cloudflare Durable Objects

## Table of Contents

1. [Overview](#overview)
2. [Design Goals](#design-goals)
3. [Architecture](#architecture)
4. [Components](#components)
5. [Protocol](#protocol)
6. [Data Storage](#data-storage)
7. [LLM Integration](#llm-integration)
8. [Agent Loop](#agent-loop)
9. [Tool Execution](#tool-execution)
10. [Session Management](#session-management)
11. [Configuration](#configuration)
12. [Skills](#skills)
13. [Error Handling](#error-handling)
14. [Security](#security)
15. [CLI](#cli)

---

## Overview

GSV is a distributed AI agent platform where:

- **Gateway DO** acts as the central router and connection hub
- **Session DOs** own conversation history and run agent loops
- **Nodes** are external tool executors (servers, phones, desktops)
- **Clients** are user interfaces (CLI, web, mobile apps)

The system enables AI agents to execute tools across distributed infrastructure while maintaining persistent conversation state.

---

## Design Goals

1. **Distributed Tool Execution**: Tools run on user-owned infrastructure (servers, laptops, phones), not in the cloud
2. **Persistent Conversations**: Sessions survive disconnections, restarts, and can be resumed from any client
3. **Scalable**: Each session is isolated in its own Durable Object
4. **Simple Protocol**: JSON-RPC-like frames over WebSocket
5. **Provider Agnostic**: Support multiple LLM providers (Anthropic, OpenAI, Google, etc.)
6. **Offline Tolerant**: Graceful handling of node disconnections mid-task

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              R2 BUCKET                                      │
│                         (shared filesystem)                                 │
│                                                                             │
│   /skills/{name}/SKILL.md          - Skill definitions                      │
│   /config/global.json              - Global configuration                   │
│   /config/users/{userId}.json      - Per-user configuration                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ (read on demand)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            GATEWAY DO                                       │
│                       (singleton instance)                                  │
│                                                                             │
│  Responsibilities:                                                          │
│  • Accept WebSocket connections from Clients, Nodes, and Sessions           │
│  • Route messages between components                                        │
│  • Maintain tool registry (which Node provides which tools)                 │
│  • Track pending tool calls for result routing                              │
│  • Broadcast events to subscribed clients                                   │
│                                                                             │
│  Does NOT:                                                                  │
│  • Run agent loops                                                          │
│  • Store conversation history                                               │
│  • Call LLM providers                                                       │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│   Session DO    │        │   Session DO    │        │   Session DO    │
│  "main:main"    │        │ "tg:group:123"  │        │  "wa:dm:steve"  │
│                 │        │                 │        │                 │
│ Responsibilities:        │                 │        │                 │
│ • Own conversation       │                 │        │                 │
│   history                │                 │        │                 │
│ • Own session config     │                 │        │                 │
│ • Run agent loop         │                 │        │                 │
│ • Request tool execution │                 │        │                 │
│ • Stream responses       │                 │        │                 │
└─────────────────┘        └─────────────────┘        └─────────────────┘
         ▲                           ▲                           ▲
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     │
                              WebSocket to Gateway
                                     │
┌────────────────────────────────────┴────────────────────────────────────────┐
│                            GATEWAY DO                                       │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│   Linux Node    │        │   macOS Node    │        │   iOS Node      │
│                 │        │                 │        │                 │
│ Tools:          │        │ Tools:          │        │ Tools:          │
│ • Read          │        │ • Read          │        │ • Camera        │
│ • Write         │        │ • Write         │        │ • Photos        │
│ • Bash          │        │ • Bash          │        │ • Shortcuts     │
│ • Docker        │        │ • AppleScript   │        │ • Contacts      │
└─────────────────┘        └─────────────────┘        └─────────────────┘
```

---

## Components

### Gateway DO

The Gateway is a singleton Durable Object that serves as the central hub.

**State:**

```typescript
interface GatewayState {
  // Connected WebSockets by role
  clients: Map<string, WebSocket>;      // clientId → ws
  sessions: Map<string, WebSocket>;     // sessionKey → ws
  nodes: Map<string, WebSocket>;        // nodeId → ws
  
  // Tool registry: which nodes provide which tools
  toolRegistry: Map<string, Set<string>>;  // toolName → Set<nodeId>
  
  // Pending tool calls for routing results
  pendingToolCalls: Map<string, string>;   // callId → sessionKey
}
```

**Responsibilities:**

1. Accept and authenticate WebSocket connections
2. Route `chat.send` requests to appropriate Session DO
3. Route `tool.request` from Sessions to appropriate Node
4. Route `tool.result` from Nodes back to requesting Session
5. Broadcast events to subscribed clients
6. Track node availability and tool registry

### Session DO

Each Session DO represents a single conversation context.

**State (Persisted in DO Storage):**

```typescript
interface SessionState {
  // Identity
  sessionKey: string;           // e.g., "main:main", "tg:group:123"
  createdAt: number;
  updatedAt: number;
  
  // Conversation
  messages: Message[];          // Full conversation history
  
  // Configuration (overrides global config)
  config: {
    model?: string;             // e.g., "anthropic/claude-sonnet-4-20250514"
    thinkingLevel?: ThinkingLevel;
    maxTokens?: number;
    tools?: string[];           // Allowed tools for this session
  };
  
  // Token tracking
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  
  // Metadata
  label?: string;               // User-defined label
  lastChannel?: string;         // Last channel used (telegram, webchat, etc.)
}
```

**Runtime State (Not Persisted):**

```typescript
interface SessionRuntime {
  gatewayWs: WebSocket | null;
  currentRunId: string | null;
  pendingToolCalls: Map<string, ToolCall>;
}
```

**Responsibilities:**

1. Persist and load conversation history
2. Run the agent loop (call LLM, handle tool calls)
3. Request tool execution via Gateway
4. Stream responses back to clients via Gateway
5. Handle session configuration

### Node

Nodes are external processes that connect to the Gateway and execute tools.

**Registration:**

```typescript
interface NodeRegistration {
  id: string;                   // Unique node identifier
  name: string;                 // Human-readable name
  platform: string;             // "linux", "macos", "ios", "android"
  tools: ToolDefinition[];      // Tools this node provides
}

interface ToolDefinition {
  name: string;                 // e.g., "Bash", "Read", "Camera"
  description: string;
  inputSchema: JSONSchema;      // JSON Schema for tool arguments
}
```

**Responsibilities:**

1. Connect to Gateway and register available tools
2. Execute tool invocations received from Gateway
3. Return tool results to Gateway
4. Handle disconnection/reconnection gracefully

### Client

Clients are user interfaces that connect to the Gateway.

**Types:**

- **CLI/TUI**: Terminal-based interface
- **WebChat**: Browser-based chat UI
- **Mobile App**: iOS/Android companion apps
- **API Client**: Programmatic access

**Capabilities:**

- Send messages to sessions
- Receive streamed responses
- View/manage sessions
- Configure settings

---

## Protocol

All communication uses JSON frames over WebSocket.

### Frame Types

```typescript
// Request: Client/Session/Node → Gateway (or Gateway → Session)
type RequestFrame = {
  type: "req";
  id: string;           // UUID for correlation
  method: string;       // Method name
  params?: unknown;     // Method-specific parameters
};

// Response: Acknowledges a request
type ResponseFrame = {
  type: "res";
  id: string;           // Matches request id
  ok: boolean;
} & (
  | { ok: true; payload?: unknown }
  | { ok: false; error: ErrorShape }
);

// Event: Unsolicited push from Gateway/Session
type EventFrame = {
  type: "evt";
  event: string;        // Event name
  payload?: unknown;    // Event data
  seq?: number;         // Sequence number for ordering
};

type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};
```

### Connection Handshake

```typescript
// 1. Client opens WebSocket to Gateway
// 2. Client sends connect request:
{
  type: "req",
  id: "uuid",
  method: "connect",
  params: {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "client-uuid",
      name: "My CLI",
      version: "1.0.0",
      platform: "macos",
      mode: "client" | "node" | "session"
    },
    // For nodes only:
    tools?: [
      { name: "Bash", description: "...", inputSchema: {...} },
      { name: "Read", description: "...", inputSchema: {...} }
    ],
    // For sessions only:
    sessionKey?: "main:main"
  }
}

// 3. Gateway responds:
{
  type: "res",
  id: "uuid",
  ok: true,
  payload: {
    protocol: 1,
    server: {
      version: "1.0.0",
      connectionId: "conn-uuid"
    },
    features: {
      methods: ["chat.send", "chat.history", ...],
      events: ["chat", "tool", ...]
    }
  }
}
```

### Methods

#### Client → Gateway

| Method | Description | Params |
|--------|-------------|--------|
| `connect` | Initial handshake | `{ client, tools?, sessionKey? }` |
| `chat.send` | Send message to session | `{ sessionKey, message, runId }` |
| `chat.abort` | Abort active run | `{ sessionKey, runId? }` |
| `chat.history` | Get conversation history | `{ sessionKey, limit? }` |
| `sessions.list` | List all sessions | `{ limit?, offset? }` |
| `sessions.patch` | Update session config | `{ sessionKey, config }` |
| `sessions.reset` | Clear session history | `{ sessionKey }` |
| `sessions.delete` | Delete a session | `{ sessionKey }` |
| `nodes.list` | List connected nodes | `{}` |
| `config.get` | Get configuration | `{ path? }` |
| `config.set` | Set configuration | `{ path, value }` |

#### Gateway → Session DO

| Method | Description | Params |
|--------|-------------|--------|
| `chat.send` | Forward chat message | `{ message, runId, clientId }` |
| `chat.abort` | Abort current run | `{ runId? }` |
| `tool.result` | Deliver tool result | `{ callId, result?, error? }` |

#### Session DO → Gateway

| Method | Description | Params |
|--------|-------------|--------|
| `tool.request` | Request tool execution | `{ callId, tool, args, sessionKey }` |

#### Gateway → Node

| Event | Description | Payload |
|-------|-------------|---------|
| `tool.invoke` | Execute a tool | `{ callId, tool, args }` |

#### Node → Gateway

| Method | Description | Params |
|--------|-------------|--------|
| `tool.result` | Return tool result | `{ callId, result?, error? }` |

### Events

#### Gateway → Client

| Event | Description | Payload |
|-------|-------------|---------|
| `chat` | Chat updates | `{ runId, sessionKey, state, ... }` |
| `node.connected` | Node came online | `{ nodeId, tools }` |
| `node.disconnected` | Node went offline | `{ nodeId }` |
| `session.updated` | Session changed | `{ sessionKey, ... }` |

#### Chat Event States

```typescript
type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  seq: number;
} & (
  | { state: "started" }
  | { state: "delta"; text: string }
  | { state: "tool_start"; tool: string; callId: string }
  | { state: "tool_end"; tool: string; callId: string; result?: unknown }
  | { state: "error"; error: string }
  | { state: "final"; message: Message }
);
```

---

## Data Storage

### R2 Bucket (Shared Filesystem)

Used for data that needs to be accessible by all DOs or external systems.

```
/
├── config/
│   ├── global.json              # Global configuration
│   └── users/
│       └── {userId}.json        # Per-user config overrides
│
├── skills/
│   ├── himalaya/
│   │   ├── SKILL.md             # Skill definition
│   │   └── references/          # Supporting docs
│   └── nano-pdf/
│       └── SKILL.md
│
└── transcripts/                  # Optional: archived transcripts
    └── {sessionId}.jsonl
```

**Rationale:**

- Skills are shared across all sessions
- Global config applies to all users
- R2 can be mounted via FUSE for local access
- Transcripts can be archived here for long-term storage

### Session DO Storage

Each Session DO uses Durable Object storage for its private state.

```typescript
// Keys used in DO storage:
"messages"      → Message[]           // Conversation history
"config"        → SessionConfig       // Session-specific overrides
"metadata"      → SessionMetadata     // Token counts, timestamps, etc.
```

**Rationale:**

- Co-located with Session DO for fast access
- Isolated per-session (no cross-session leakage)
- Automatically persisted and replicated

**Limitations:**

- 128KB per key (shard large histories)
- 10GB total per DO (archive old data to R2)

### Gateway DO Storage

Gateway uses minimal storage (mostly runtime state).

```typescript
// Persisted (survives restarts):
"nodeRegistry"  → NodeRegistration[]  // Known nodes (for reconnection)

// Runtime only (rebuilt on connect):
// - clients, sessions, nodes maps
// - toolRegistry
// - pendingToolCalls
```

---

## LLM Integration

Session DOs use `@mariozechner/pi-ai` for LLM provider calls. This library provides:

- **Multi-provider support**: Anthropic, OpenAI, Google, Mistral, etc.
- **Unified types**: Consistent `Message`, `ToolCall`, `ContentBlock` types across providers
- **Model registry**: Validated model lookup via `getModel(provider, modelId)`
- **Workers compatible**: Runs in Cloudflare Workers/Durable Objects

### Installation

```bash
npm install @mariozechner/pi-ai
```

### Usage in Session DO

```typescript
import { completeSimple, getModel } from "@mariozechner/pi-ai";

class Session extends DurableObject<Env> {
  async callLlm(): Promise<LlmResponse> {
    const config = await this.getConfig();
    const [provider, modelId] = config.model.split("/");
    const model = getModel(provider, modelId);
    
    // Build context from conversation history
    const context = {
      system: this.systemPrompt,
      messages: this.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      tools: this.getToolDefinitions(),
    };
    
    // Call LLM (non-streaming)
    const result = await completeSimple(model, context, {
      apiKey: this.env.ANTHROPIC_API_KEY,  // Pass explicitly
    });
    
    return {
      message: result,
      toolCalls: result.content
        .filter(block => block.type === "tool_use")
        .map(block => ({
          id: block.id,
          name: block.name,
          args: block.input,
        })),
    };
  }
}
```

### Supported Providers

| Provider | Model Examples | Notes |
|----------|---------------|-------|
| `anthropic` | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` | Primary, recommended |
| `openai` | `gpt-4o`, `gpt-4-turbo` | Full support |
| `google` | `gemini-2.0-flash`, `gemini-1.5-pro` | Use `google` not `google-vertex` |
| `mistral` | `mistral-large-latest` | Full support |

### API Key Management

API keys should be stored in Cloudflare Secrets and accessed via `env`:

```typescript
// wrangler.toml
[vars]
# Don't put secrets here!

# Use wrangler secret put
# wrangler secret put ANTHROPIC_API_KEY
```

```typescript
// Access in DO
const apiKey = this.env.ANTHROPIC_API_KEY;
```

### Error Handling

```typescript
try {
  const result = await completeSimple(model, context, { apiKey });
} catch (error) {
  if (error.status === 429) {
    // Rate limited - retry with backoff
  } else if (error.status === 401) {
    // Invalid API key
  } else if (error.message?.includes("context_length")) {
    // Context overflow - need to compact history
  }
}
```

### Future: Streaming Support

Streaming is not implemented in Phase 1. When added:

```typescript
import { streamSimple } from "@mariozechner/pi-ai";

const stream = streamSimple(model, context, { apiKey });

for await (const event of stream) {
  if (event.type === "content_block_delta") {
    // Send delta to client
    this.sendEvent("chat", { state: "delta", text: event.delta.text });
  }
}

const result = await stream.result();
```

---

## Agent Loop

The agent loop runs inside Session DOs and is driven by WebSocket messages.

### Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENT LOOP                                        │
│                                                                             │
│  1. chat.send arrives via WebSocket                                         │
│     └─► DO wakes up                                                         │
│                                                                             │
│  2. Append user message to history                                          │
│                                                                             │
│  3. Call LLM API (await)         ◄── Only blocking operation               │
│     └─► Returns assistant message (possibly with tool_use)                  │
│                                                                             │
│  4. Append assistant message to history                                     │
│                                                                             │
│  5. If tool_use in response:                                                │
│     a. Send tool.request to Gateway (non-blocking WS send)                  │
│     b. Set timeout alarm (60s)                                              │
│     c. return ◄── DO goes idle                                              │
│                                                                             │
│  6. tool.result arrives via WebSocket                                       │
│     └─► DO wakes up                                                         │
│                                                                             │
│  7. Build tool result message, append to history                            │
│                                                                             │
│  8. Go to step 3 (call LLM again)                                           │
│                                                                             │
│  9. If no tool_use: send final response, done                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
class Session extends DurableObject<Env> {
  async webSocketMessage(ws: WebSocket, message: string) {
    const frame = JSON.parse(message);
    
    switch (frame.method) {
      case "chat.send":
        this.messages.push({ role: "user", content: frame.params.message });
        this.currentRunId = frame.params.runId;
        await this.continueLoop();
        break;
        
      case "tool.result":
        this.pendingToolCalls.get(frame.params.callId).result = frame.params.result;
        if (this.allToolsResolved()) {
          this.ctx.storage.deleteAlarm();
          await this.continueLoop();
        }
        break;
    }
  }
  
  async continueLoop() {
    // Inject pending tool results if any
    if (this.pendingToolCalls.size > 0) {
      this.messages.push(this.buildToolResultMessage());
      this.pendingToolCalls.clear();
    }
    
    // Call LLM (only await in the loop)
    const response = await this.callLlm();
    this.messages.push(response.message);
    await this.persistMessages();
    
    // Stream text to clients
    this.sendEvent("chat", { 
      runId: this.currentRunId,
      state: "delta", 
      text: response.message.content 
    });
    
    // Handle tool calls
    if (response.toolCalls?.length) {
      for (const call of response.toolCalls) {
        this.pendingToolCalls.set(call.id, call);
        this.sendRequest("tool.request", {
          callId: call.id,
          tool: call.name,
          args: call.args,
          sessionKey: this.sessionKey
        });
      }
      
      // Timeout alarm in case node dies
      this.ctx.storage.setAlarm(Date.now() + 60_000);
      return; // Go idle, wait for tool results
    }
    
    // No tools - done
    this.sendEvent("chat", {
      runId: this.currentRunId,
      state: "final",
      message: response.message
    });
    this.currentRunId = null;
  }
  
  async alarm() {
    // Tool timeout
    if (this.pendingToolCalls.size > 0) {
      for (const [id, call] of this.pendingToolCalls) {
        if (!call.result) call.error = "Tool execution timed out";
      }
      await this.continueLoop();
    }
  }
}
```

---

## Tool Execution

### Tool Request Flow

```
Session DO                    Gateway DO                    Node
    │                             │                           │
    │  tool.request               │                           │
    │  {callId, tool, args}       │                           │
    │────────────────────────────►│                           │
    │                             │                           │
    │                             │  (lookup tool registry)   │
    │                             │  tool "Bash" → "linux-1"  │
    │                             │                           │
    │                             │  tool.invoke              │
    │                             │  {callId, tool, args}     │
    │                             │──────────────────────────►│
    │                             │                           │
    │                             │                           │  (execute)
    │                             │                           │
    │                             │  tool.result              │
    │                             │  {callId, result}         │
    │                             │◄──────────────────────────│
    │                             │                           │
    │  tool.result                │                           │
    │  {callId, result}           │                           │
    │◄────────────────────────────│                           │
    │                             │                           │
```

### Tool Registry

Gateway maintains a registry of which nodes provide which tools:

```typescript
interface ToolRegistry {
  // Tool name → Set of node IDs that provide it
  tools: Map<string, Set<string>>;
  
  // Node ID → List of tools it provides
  nodes: Map<string, ToolDefinition[]>;
}

// When routing a tool request:
function routeToolRequest(tool: string): string | null {
  const nodeIds = this.toolRegistry.tools.get(tool);
  if (!nodeIds?.size) return null;
  
  // Simple: pick first available
  // Future: load balancing, affinity, latency-based
  for (const nodeId of nodeIds) {
    if (this.nodes.has(nodeId)) {
      return nodeId;
    }
  }
  return null;
}
```

### Standard Tools

Nodes should implement these standard tools where applicable:

| Tool | Description | Typical Platforms |
|------|-------------|-------------------|
| `Read` | Read file contents | All |
| `Write` | Write/create file | All |
| `Edit` | Edit existing file | All |
| `Bash` | Execute shell command | Linux, macOS |
| `Glob` | Find files by pattern | All |
| `Grep` | Search file contents | All |
| `WebFetch` | Fetch URL content | All |
| `Camera` | Capture photo | iOS, Android |
| `Photos` | Access photo library | iOS, Android |
| `Contacts` | Access contacts | iOS, Android |
| `AppleScript` | Run AppleScript | macOS |
| `Shortcuts` | Run iOS Shortcuts | iOS |

### Tool Schema Example

```typescript
const BashTool: ToolDefinition = {
  name: "Bash",
  description: "Execute a shell command",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute"
      },
      workdir: {
        type: "string",
        description: "Working directory (optional)"
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (optional)"
      }
    },
    required: ["command"]
  }
};
```

---

## Session Management

### Session Keys

Session keys are hierarchical identifiers:

```
agent:{agentId}:{context}
```

**Examples:**

| Key | Description |
|-----|-------------|
| `agent:main:main` | Default/main conversation |
| `agent:main:tg:group:-1001234` | Telegram group |
| `agent:main:discord:channel:5678` | Discord channel |
| `agent:main:wa:dm:+14155551234` | WhatsApp DM |
| `agent:main:dm:steve` | Cross-channel DM (identity linked) |
| `agent:research:main` | Different agent's main session |

### Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SESSION LIFECYCLE                                    │
│                                                                             │
│  1. CREATION                                                                │
│     First message to a session key creates the Session DO                   │
│     └─► DO Storage initialized with empty state                             │
│                                                                             │
│  2. ACTIVE                                                                  │
│     Messages flow through, history accumulates                              │
│     └─► DO wakes on each message, persists after each run                   │
│                                                                             │
│  3. IDLE                                                                    │
│     No active runs, DO may be evicted from memory                           │
│     └─► State persists in DO Storage, reloads on next message              │
│                                                                             │
│  4. RESET                                                                   │
│     User requests history clear                                             │
│     └─► Messages cleared, config preserved                                  │
│                                                                             │
│  5. DELETION                                                                │
│     User deletes session                                                    │
│     └─► All DO Storage cleared, DO can be garbage collected                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Session Configuration

Each session can override global configuration:

```typescript
interface SessionConfig {
  // Model settings
  model?: string;                    // Override model
  thinkingLevel?: "off" | "low" | "medium" | "high";
  maxTokens?: number;
  
  // Tool restrictions
  tools?: {
    allow?: string[];                // Whitelist (if set, only these)
    deny?: string[];                 // Blacklist
  };
  
  // Behavior
  systemPrompt?: string;             // Additional system prompt
  
  // Metadata
  label?: string;                    // User-defined label
}
```

---

## Configuration

### Configuration Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CONFIGURATION HIERARCHY                                │
│                                                                             │
│  1. Hardcoded Defaults                                                      │
│     └─► Built into the system                                               │
│                                                                             │
│  2. Global Config (R2: /config/global.json)                                 │
│     └─► Applies to all users/sessions                                       │
│                                                                             │
│  3. User Config (R2: /config/users/{userId}.json)                           │
│     └─► Per-user overrides                                                  │
│                                                                             │
│  4. Session Config (Session DO Storage)                                     │
│     └─► Per-session overrides                                               │
│                                                                             │
│  5. Runtime Overrides (inline directives)                                   │
│     └─► /think high, /model claude-opus, etc.                               │
│                                                                             │
│  Priority: 5 > 4 > 3 > 2 > 1                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Global Configuration Schema

```typescript
interface GlobalConfig {
  // Default model settings
  model: {
    primary: string;                 // e.g., "anthropic/claude-sonnet-4-20250514"
    fallbacks?: string[];            // Fallback models on failure
  };
  
  // Default thinking level
  thinkingDefault: "off" | "low" | "medium" | "high";
  
  // Timeouts
  timeoutSeconds: number;            // Default: 300
  toolTimeoutSeconds: number;        // Default: 60
  
  // API credentials (or reference to secrets)
  auth: {
    anthropic?: { apiKey: string };
    openai?: { apiKey: string };
    google?: { apiKey: string };
  };
  
  // Skills configuration
  skills: {
    enabled: string[];               // Enabled skill names
    disabled: string[];              // Explicitly disabled
  };
  
  // Tool defaults
  tools: {
    allow?: string[];                // Global tool whitelist
    deny?: string[];                 // Global tool blacklist
  };
}
```

---

## Skills

Skills are documentation packages that teach the agent how to use external tools/CLIs.

### Skill Structure

```
/skills/{name}/
├── SKILL.md              # Main skill definition (required)
└── references/           # Supporting documentation (optional)
    ├── config.md
    └── examples.md
```

### SKILL.md Format

```markdown
---
name: himalaya
description: "CLI to manage emails via IMAP/SMTP"
metadata: {
  "emoji": "📧",
  "requires": {
    "bins": ["himalaya"]
  },
  "install": [
    {"kind": "brew", "formula": "himalaya"}
  ]
}
---

# Himalaya Email CLI

Use `himalaya` to manage emails from the terminal.

## Common Operations

### List Emails
```bash
himalaya envelope list
```

### Read Email
```bash
himalaya message read 42
```

... (usage examples)
```

### Skill Loading

1. Gateway loads skills from R2 `/skills/` on startup
2. Skills are filtered by:
   - `requires.bins` - Required binaries (checked against node capabilities)
   - `requires.env` - Required environment variables
   - Config allow/deny lists
3. Filtered skills are injected into the system prompt

### Skill Metadata

```typescript
interface SkillMetadata {
  emoji?: string;                    // Display emoji
  homepage?: string;                 // Project URL
  os?: string[];                     // OS restrictions
  
  requires?: {
    bins?: string[];                 // Required binaries
    env?: string[];                  // Required env vars
  };
  
  install?: SkillInstallSpec[];      // Auto-install instructions
}

interface SkillInstallSpec {
  kind: "brew" | "npm" | "pip" | "cargo" | "go";
  package?: string;
  formula?: string;
  bins?: string[];                   // Binaries it provides
}
```

---

## Error Handling

### Error Categories

| Category | Examples | Handling |
|----------|----------|----------|
| **Protocol Errors** | Invalid frame, unknown method | Return error response |
| **Auth Errors** | Invalid token, expired session | Close connection with reason |
| **LLM Errors** | Rate limit, API error | Retry with backoff, fallback model |
| **Tool Errors** | Node offline, execution failed | Return error to LLM, let it adapt |
| **Timeout Errors** | Tool didn't respond | Inject timeout error, continue loop |

### Error Response Format

```typescript
{
  type: "res",
  id: "request-id",
  ok: false,
  error: {
    code: 1001,
    message: "Tool execution failed",
    details: { tool: "Bash", nodeId: "linux-1" },
    retryable: true
  }
}
```

### Error Codes

| Code | Category | Description |
|------|----------|-------------|
| 1000 | Protocol | Invalid frame format |
| 1001 | Protocol | Unknown method |
| 1002 | Protocol | Missing required parameter |
| 2000 | Auth | Authentication required |
| 2001 | Auth | Invalid token |
| 2002 | Auth | Permission denied |
| 3000 | Session | Session not found |
| 3001 | Session | Session busy (run in progress) |
| 4000 | Tool | Tool not found |
| 4001 | Tool | No node provides tool |
| 4002 | Tool | Tool execution failed |
| 4003 | Tool | Tool timeout |
| 5000 | LLM | Provider error |
| 5001 | LLM | Rate limited |
| 5002 | LLM | Context overflow |

### Retry Strategy

```typescript
interface RetryConfig {
  maxAttempts: number;               // Default: 3
  baseDelayMs: number;               // Default: 1000
  maxDelayMs: number;                // Default: 30000
  backoffMultiplier: number;         // Default: 2
}

// LLM call retry
async function callLlmWithRetry(config: RetryConfig): Promise<LlmResponse> {
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await this.callLlm();
    } catch (error) {
      if (!isRetryable(error) || attempt === config.maxAttempts) {
        throw error;
      }
      const delay = Math.min(
        config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
        config.maxDelayMs
      );
      await sleep(delay);
    }
  }
}
```

---

## Security

### Authentication

**Clients:**
- Connect with bearer token in `connect` params
- Token validated against user database
- Scoped permissions (read, write, admin)

**Nodes:**
- Pre-shared key or certificate
- Registered in config with allowed tools
- Can be restricted to specific sessions

**Sessions:**
- Internal only (DO-to-DO communication)
- Authenticated by Cloudflare's internal routing

### Authorization

```typescript
interface Permissions {
  // Session access
  sessions: {
    read: string[];                  // Session keys user can read
    write: string[];                 // Session keys user can write
    admin: string[];                 // Session keys user can configure
  };
  
  // Tool access
  tools: {
    allow: string[];                 // Tools user can invoke
    deny: string[];                  // Tools user cannot invoke
  };
  
  // Node access
  nodes: {
    allow: string[];                 // Nodes user can use
  };
}
```

### Data Protection

1. **In Transit**: All WebSocket connections over TLS
2. **At Rest**: DO Storage encrypted by Cloudflare
3. **API Keys**: Stored in Cloudflare Secrets, never in R2
4. **Transcripts**: Can be encrypted with user-provided key

### Tool Sandboxing

Nodes should implement sandboxing for tool execution:

```typescript
interface ToolExecutionContext {
  // Working directory restriction
  workdir: string;
  allowedPaths: string[];
  
  // Command restrictions
  allowedCommands?: string[];
  deniedCommands?: string[];
  
  // Resource limits
  timeoutMs: number;
  maxOutputBytes: number;
  
  // Network restrictions
  allowNetwork: boolean;
  allowedHosts?: string[];
}
```

---

## Future Considerations

### Not In Scope (Yet)

1. **Streaming from LLM**: Currently wait for full response; could stream deltas
2. **Parallel Tool Calls**: Execute multiple tool calls concurrently
3. **Sub-agents**: Spawn child agents for complex tasks
4. **Memory/RAG**: Vector search over conversation history
5. **Webhooks**: Push events to external systems
6. **Multi-tenancy**: Multiple users sharing infrastructure

### Migration Path

1. **Phase 1**: Core architecture (Gateway, Session, basic tools)
2. **Phase 2**: Node ecosystem (iOS, Android, desktop apps)
3. **Phase 3**: Advanced features (streaming, parallel tools)
4. **Phase 4**: Memory and RAG integration
5. **Phase 5**: Multi-tenancy and enterprise features

---

## Appendix: Message Types

### LLM Message Format

```typescript
type Message = 
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[]; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;  // JSON string
  };
};
```

### Internal Message Extensions

```typescript
interface ExtendedMessage extends Message {
  // Metadata (not sent to LLM)
  _meta?: {
    timestamp: number;
    runId?: string;
    tokenCount?: number;
    latencyMs?: number;
  };
}
```
