# Context Compaction and Memory

Every LLM has a finite context window. Claude has 200K tokens. GPT-4 has 128K. But conversations are, in principle, infinite. A personal AI agent that you talk to every day generates megabytes of conversation history over weeks and months. The context window is a hard physical constraint, and any long-lived agent system must grapple with it.

GSV's answer to this problem is a layered continuity system that combines in-session compaction, compact prompt context, repo-backed wiki memory, and session archival. Understanding how these layers interact — and what is lost at each stage — is key to understanding the agent's behavior over time.

## The Fundamental Problem

Consider what's in the context window when the LLM is called:

- **System prompt**: Personality, operating instructions, compact context files, tool definitions, and runtime context. This alone can be 3,000-10,000 tokens depending on configuration.
- **Conversation history**: Every user message, every assistant response, every tool call and its result. Tool results can be massive — a `Bash` command that outputs 200 lines of log data might be 2,000+ tokens.
- **Tool definitions**: JSON schemas for every available tool. With multiple nodes connected, this can be 50+ tools.

In a typical coding session, the context fills up fast. Each tool call round-trip adds hundreds of tokens. A session where the agent reads several files, makes edits, and runs tests can easily consume 50,000+ tokens in 30 minutes.

Without compaction, the conversation would simply hit the context limit and fail. The user would need to manually reset the session, losing all context. GSV automates this process to keep conversations flowing while preserving what matters.

## Proactive Compaction

The first line of defense is proactive compaction, which triggers *before* the LLM call when the system detects the context is getting large.

Before each LLM call, the Session estimates the total context size. It uses two approaches for this estimation:

1. **Last known input tokens**: After each successful LLM call, the provider reports actual token usage. The Session stores the last input token count. This is the most accurate signal — it reflects exactly how many tokens the provider counted, including system prompt, messages, and tool definitions.

2. **Character-based estimation**: When no prior LLM usage data is available (first call in a session, or after a reset), the system falls back to a heuristic: `JSON.stringify(message).length / 4 * 1.2`. Dividing by 4 gives a rough character-to-token ratio, and the 1.2 multiplier adds a safety margin. This isn't accurate for any individual message, but it's good enough for budgeting purposes.

The compaction threshold is `contextWindow - reserveTokens`, where `reserveTokens` is a configurable buffer (ensuring room for the next response and some tool results). When the estimated context exceeds this threshold, compaction is triggered.

## What Compaction Actually Does

Compaction is a multi-step process implemented in `gateway/src/session/compaction.ts`:

### 1. Split Old and Recent

The message history is divided into "old" messages (to be summarized) and "recent" messages (to be kept verbatim). The split point is determined by `keepRecentTokens` — the system walks backward from the most recent message, accumulating tokens, until the budget is exhausted. Everything before that point is "old."

The recent tail is always preserved exactly. This ensures the agent retains full fidelity of the most recent exchanges — the user's last question, the last tool call results, the current thread of work. What gets compressed is the beginning of the conversation: the initial pleasantries, earlier tasks that were completed, context that informed decisions already made.

### 2. Chunk the Old Messages

The old messages are divided into chunks of roughly 25% of the context window each. This chunking serves two purposes: it keeps each summarization call within the LLM's own context limits, and it allows incremental processing with rolling context.

### 3. Three-Tier Summarization

Compaction uses a three-tier fallback chain, and this is where the design gets interesting:

**Tier 1 — Full summarization**: Each chunk is sent to the LLM with a summarization prompt. The LLM is asked to produce a concise narrative preserving decisions, action items, technical context, and current state. Chunks are processed sequentially with rolling context — the summary from chunk N is included in the prompt for chunk N+1, building a progressive summary.

**Tier 2 — Partial summarization**: If full summarization fails (perhaps a chunk is too large to fit in the summarization LLM's own context), the system falls back to partial mode. Oversized chunks (more than 50% of the context window) are skipped with a placeholder note. The remaining chunks are summarized normally.

**Tier 3 — Plaintext fallback**: If even partial summarization fails (API errors, rate limits), the system falls back to a plain text placeholder: "[Context contained N messages that were compacted. Summary unavailable due to size limits.]" This loses information but keeps the session functional.

### 4. Replace and Archive

The old messages are replaced in SQLite with a single synthetic "user" message containing the summary (marked as `[Conversation summary from automatic context compaction]`). The original old messages are archived to R2 as a partial JSONL archive — they're not lost, just moved to cold storage.

The recent messages are kept verbatim after the summary. From the LLM's perspective on the next call, it sees: a summary of earlier conversation, then the recent exchanges in full detail.

## Memory Capture

Compaction protects the active conversation from overflowing the model context. It is not the primary long-term memory store. Durable facts such as "The user prefers TypeScript over JavaScript," "The project uses pnpm, not npm," or "The deploy pipeline runs on GitHub Actions" should be written to the agent's repo-backed `memory` wiki when they are useful beyond the current session.

Each agent has a conventional wiki id:

```text
memory
```

After initialization, it is available as normal markdown under:

```text
/src/repos/<agent>/memory/index.md
/src/repos/<agent>/memory/pages/
/src/repos/<agent>/memory/pages/journal/YYYY/MM/YYYY-MM-DD.md
```

Create it with:

```bash
wiki db init memory --title "<agent> Memory"
```

Unlike `~/context.d`, wiki pages are not loaded into every prompt. The agent searches and reads them deliberately when relevant. This keeps prompts small while making hundreds of memory files discoverable.

## Long-Term Memory: Wiki Pages

Use the `memory` wiki for curated long-term knowledge. The baseline structure is:

```text
index.md
pages/journal/YYYY/MM/YYYY-MM-DD.md
pages/people/
pages/projects/
pages/preferences/
pages/decisions/
```

Chronological journal entries are a good default capture path. Stable facts should be promoted into topical pages so search finds the canonical source instead of many duplicate daily notes. Active open loops belong in `~/context.d/20-open-loops.md` so they are loaded into every prompt; the wiki can keep closed-loop history and supporting evidence.

## Session Reset and Archival

When a session is reset (manually via `/reset` or automatically via reset policy), the entire conversation history is archived to R2 as a gzipped JSONL file at `agents/{agentId}/sessions/{sessionId}.jsonl.gz`. The Session DO generates a new session ID, clears its SQLite messages, and resets token counters.

The archived transcript is still accessible in cold storage, but it will not be loaded into future prompts. Durable facts that should survive reset should be written to the agent's `memory` wiki before the session is forgotten.

Reset policies automate this process:

- **Manual**: The default. Sessions persist until explicitly reset.
- **Daily**: Session resets at a specified hour (default 4 AM). Good for maintaining a daily conversation rhythm without unbounded history growth.
- **Idle**: Session resets after a period of inactivity (configurable minutes). Good for treating each interaction burst as a separate conversation.

## The Memory Lifecycle

Putting it all together, information in GSV flows through a lifecycle:

```
Active conversation (SQLite in Session DO)
  → Compaction (when context window fills)
    → Summary replaces old messages in SQLite
    → Old messages archived to R2 (.jsonl.gz)
  → Session reset (manual or policy-based)
    → Full transcript archived to R2
    → Session cleared
  → Prompt-critical standing context stays in ~/context.d/
  → Long-term memories are searched and curated in the agent's memory wiki
```

At each stage, information is compressed and distilled. A detailed tool call result ("Here are 200 lines of test output...") becomes a summary sentence ("Tests passed after fixing the import path"). If that fact matters later, the agent should record it in wiki memory, where it can be searched without loading every note into the prompt. The fidelity decreases, but the durability and retrievability increase.

## What Is Lost

It's important to be honest about what compaction loses. This isn't a lossless compression system.

**Exact tool outputs** are the biggest casualty. When the agent reads a file, the full file content is in the conversation history. After compaction, only a summary of what was read remains. If the agent needs to refer to that file's exact contents later, it needs to read it again.

**Conversational nuance** gets flattened. The back-and-forth of "Actually, could you try it this way instead?" and "Oh wait, I meant the other file" compresses to something like "Revised approach to use X instead of Y." The reasoning path is lost; only the conclusion survives.

**Image content** can't be summarized into text. Compaction notes how many images were present but can't describe them. If the conversation involved sharing screenshots for debugging, that visual context is gone after compaction.

These trade-offs are inherent to operating within context window limits. The system is designed to preserve *actionable* information — what was decided, what was done, what's still pending — at the cost of *incidental* details. For a long-running personal agent, this is usually the right trade-off.

## Token Estimation

GSV doesn't use a real tokenizer for estimation. Running `tiktoken` or equivalent in a Cloudflare Worker is possible but adds dependency weight and execution time. Instead, the system uses a simple heuristic: `characters / 4 * 1.2`.

This is deliberately conservative. Real token counts vary by model and content (code tokenizes differently from prose, non-English text differs from English). The 1.2x safety margin means compaction triggers a bit earlier than strictly necessary, which is preferable to triggering too late and hitting a hard context overflow.

The most accurate signal comes from the LLM provider itself. After each call, the usage response includes actual input token counts. GSV caches this value and uses it as the primary compaction trigger on the next call. This means the first call after a reset uses the heuristic estimate, but subsequent calls use real data. In practice, the system quickly converges to accurate triggering.
