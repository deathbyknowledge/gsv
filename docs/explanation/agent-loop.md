# The Agent Loop

The agent loop is the heartbeat of GSV. It's the cycle that transforms a user's message into a response — potentially involving multiple LLM calls, tool executions across distributed nodes, and streaming partial results back to the user. Understanding this loop is essential to understanding how GSV behaves, why it makes certain choices, and what happens when things go wrong.

## The Lifecycle of a Message

When a message arrives at a Session DO, it doesn't just get forwarded to an LLM. The Session orchestrates a multi-phase process:

1. **Message intake**: The message is persisted to SQLite, the session metadata is updated, and a "run" is created.
2. **Prompt assembly**: The system prompt is built from workspace files in R2, combined with tool definitions, runtime context, and skill metadata.
3. **Compaction check**: Before calling the LLM, the Session checks whether the conversation history is approaching the model's context window limit and compacts if needed.
4. **LLM call**: The assembled context (system prompt + message history + tool definitions) is sent to the configured LLM provider.
5. **Response handling**: If the LLM returns text, it's broadcast to clients. If it returns tool calls, they're dispatched, and the loop continues from step 3 after results return.

This cycle repeats until the LLM produces a response with no tool calls — the "final" response. The entire process is asynchronous and designed to survive DO hibernation at key points.

## Prompt Assembly: Building the Agent's World

The system prompt is the lens through which the agent sees everything. It's not a static string — it's dynamically assembled from multiple sources every time the LLM is called. This is one of the more nuanced parts of GSV's design.

The `buildSystemPromptFromWorkspace` function in `gateway/src/agents/prompt.ts` assembles the prompt in a specific order, and that order matters. Each layer adds context that builds on what came before:

1. **Base prompt**: A configurable foundation ("You are a helpful AI assistant running inside GSV" by default).
2. **Tooling section**: Lists all available tools with their names and descriptions. This is critical — the LLM needs to know exactly what tools are available and how they're named.
3. **Tool call style**: Instructions about when to narrate tool usage vs. executing silently.
4. **Safety constraints**: Boundaries around self-preservation, sandbox-escaping, and destructive actions.
5. **Workspace context**: Explains the agent's workspace structure and file conventions.
6. **SOUL.md**: The agent's core personality and values — who it *is*.
7. **IDENTITY.md**: Name, class, emoji — the agent's public face.
8. **USER.md**: Information about the human — their preferences, context, what they care about.
9. **AGENTS.md**: Operating instructions — how the agent should behave in practice.
10. **MEMORY.md**: Long-term persistent memory (only loaded in the "main" session, for security reasons — you don't want personal memory leaking into channel sessions where others might see it).
11. **Daily memory files**: Recent context extracted from compacted conversations, loaded for today and yesterday.
12. **TOOLS.md**: Agent-specific notes about tool usage patterns.
13. **HEARTBEAT.md**: Configuration for proactive check-in behavior (if present).
14. **Skills section**: Available skills the agent can load on demand, with runtime eligibility filtering.
15. **Runtime context**: Current agent ID, session key, model info, timezone, connected hosts and their capabilities.

This is a lot of context, and it contributes meaningfully to token usage. The system prompt alone can easily be several thousand tokens, especially with multiple skills and connected nodes. This is one reason compaction matters — the system prompt eats into the context window budget before any conversation messages are counted.

### The Commissioning Ceremony

There's a special case worth understanding: the first run. When `BOOTSTRAP.md` exists in the agent's workspace, the prompt assembly changes significantly. Instead of the normal operation flow, the bootstrap content is injected with high priority and explicit instructions to follow the commissioning ceremony before doing anything else.

The idea is that when you first deploy GSV, the agent needs to be configured — given a name, personality, understanding of who you are. BOOTSTRAP.md contains instructions for this interactive setup process. Once commissioning is complete, the agent deletes BOOTSTRAP.md, and subsequent runs follow the normal prompt assembly path.

This is a one-time ritual that establishes the agent's identity. It's called a "commissioning ceremony" in reference to how ships in the Culture are brought online — a deliberate nod to the naming inspiration.

## The Model/Tool Loop

The core of the agent loop is the cycle between LLM calls and tool execution. This is where the agent actually *does things*.

When the LLM responds with tool calls, the Session doesn't wait for them all to complete before doing anything useful. The process is:

1. **Parse tool calls** from the LLM response's content blocks.
2. **Broadcast partial response** — if the LLM included text alongside tool calls (like "Let me check that file for you"), that text is immediately sent to clients so the user sees progress.
3. **Dispatch each tool call** through `requestToolExecution()`, which determines whether each tool is native (handled in the Gateway) or node-based (forwarded via WebSocket).
4. **Set a timeout alarm** and potentially hibernate while waiting for results.
5. **When all results arrive** (or the timeout fires), continue the loop — add tool results to the message history, call the LLM again.

This loop continues until the LLM produces a response with no tool calls. In practice, a complex task might involve 5-10 iterations: the agent reads a file, edits it, runs tests, reads the output, makes another edit, runs tests again.

### Native vs. Node Tools

Tool dispatch has a critical fork: is this tool handled inside the Gateway, or does it need to reach a node?

**Native tools** (prefixed with `gsv__`) execute within the Gateway Worker itself. These include workspace file operations — `gsv__ReadFile`, `gsv__WriteFile`, `gsv__ListFiles`, `gsv__DeleteFile`. They operate on R2 storage, so they're always available even with no nodes connected. The agent can always read and write its own workspace files. Native tools complete synchronously within the Session DO's execution context.

**Node tools** are namespaced as `{nodeId}__{toolName}` — like `macbook__Bash` or `server__Read`. The Session asks the Gateway to dispatch these, and the Gateway looks up the node in its registry, finds the WebSocket connection, and sends a `tool.invoke` event. The node executes the tool (running a shell command, reading a file, etc.) and sends the result back as a `tool.result` frame, which the Gateway routes back to the originating Session.

This is where the architecture's distributed nature becomes visible. A tool call might travel: Session DO → Gateway DO → WebSocket → Internet → Your laptop → Shell execution → Result → Internet → WebSocket → Gateway DO → Session DO → LLM. The round-trip can take seconds, and the Session must handle the asynchronous nature gracefully.

### Tool Namespacing

When multiple nodes connect, tool namespacing becomes essential. If both your laptop and your server provide a `Bash` tool, the LLM needs to know which one to use. GSV prefixes every node tool with its node ID: `laptop__Bash` vs `server__Bash`.

The system prompt includes all available tools with their namespaced names. The LLM sees them as distinct tools and can reason about which to use based on context. "The user asked about server logs, so I should use `server__Bash`" vs. "They want to edit code in their project, so I should use `laptop__Read` and `laptop__Edit`."

When the Gateway dispatches a namespaced tool call, it strips the prefix before sending to the node. The node only sees its own tool name (`Bash`, not `laptop__Bash`). The namespacing is purely a Gateway-level routing concern.

## Streaming and State Transitions

The Session communicates with clients through the Gateway using chat events with a `state` field:

- **`partial`**: The LLM produced text alongside tool calls. This is sent immediately so the user sees the agent "thinking aloud."
- **`final`**: The LLM produced a final response with no tool calls. The run is complete.
- **`error`**: Something went wrong — LLM failure, timeout, or internal error.

The run system ensures sequential processing. If a message arrives while the agent is already processing, it's queued. The Session maintains a message queue (persisted for hibernation survival) and processes messages one at a time. This prevents race conditions where two concurrent LLM calls could produce conflicting tool executions.

## Error Handling: When Things Break

The agent loop has several failure modes, each handled differently:

**LLM call failure**: If the LLM provider returns an error (rate limit, server error, invalid request), the Session broadcasts an error event and finishes the run. The conversation history is preserved — the user's message was already persisted, so they can retry.

**Tool timeout**: When tools are dispatched, the Session sets an alarm for the configured timeout (default 60 seconds). If results don't arrive in time, the alarm fires, and the Session continues the loop with timeout error messages as tool results. The LLM sees something like "Error: Tool timed out" and can respond accordingly — often by acknowledging the failure and suggesting alternatives.

**Node disconnection during tool call**: If a node disconnects while a tool call is pending, the Gateway detects this through WebSocket close events and cleans up. The pending tool call is left unresolved from the Session's perspective, which means the alarm-based timeout will eventually fire and the Session will continue with an error result.

**Context overflow**: If the LLM returns a context overflow error (too many tokens), the Session attempts reactive compaction — summarizing old messages to reduce the context size — and retries the call. This is the fallback when proactive compaction didn't trigger soon enough. If compaction doesn't help, the user gets an error suggesting they reset the session.

**DO hibernation during processing**: The Session persists its entire run state (current run info, pending tool calls, message queue) using `PersistedObject`. If the DO hibernates mid-run and wakes up later, it can examine the persisted state and determine where it left off. Alarms trigger continuation of the loop when tool results arrive or timeouts expire.

## The Message Queue

Because the agent loop is sequential — one run at a time — incoming messages while a run is active are queued. The queue is persisted (survives hibernation) and processed FIFO.

This sequential model is a deliberate simplification. A concurrent model where multiple LLM calls happen in parallel would be theoretically more responsive but practically nightmarish — imagine two concurrent tool calls trying to edit the same file, or two LLM responses giving contradictory answers. The sequential queue keeps things predictable.

When a run finishes, the Session checks for queued messages and immediately starts the next one. From the user's perspective, rapid-fire messages are processed in order, and each gets a response. There's also a priority path for system events like async exec completions — these are processed between normal messages to ensure timely handling of background task results.
