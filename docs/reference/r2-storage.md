# R2 Storage Layout Reference

GSV uses a single Cloudflare R2 bucket (`gsv-storage`) for persistent storage of agent workspace files, session archives, skill definitions, and media attachments.

## Bucket Structure

```
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
│   ├── memory/
│   │   └── {YYYY-MM-DD}.md
│   ├── sessions/
│   │   ├── {sessionId}.jsonl.gz
│   │   └── {sessionId}-part{timestamp}.jsonl.gz
│   └── skills/
│       └── {skillName}/
│           └── SKILL.md
├── skills/
│   └── {skillName}/
│       └── SKILL.md
└── media/
    └── {sessionKey}/
        └── {uuid}.{ext}
```

## Workspace Files

Workspace files are per-agent markdown files loaded at the start of each LLM call to build the system prompt. All workspace files are optional; absent files are skipped.

### Loading Order

Workspace files are loaded in parallel from R2 and assembled into the system prompt in a defined order. The loader reads from the path `agents/{agentId}/`.

**Normal operation order:**

| Order | File | Prompt Section | Condition |
|---|---|---|---|
| 1 | (base prompt) | Core scaffold | Always |
| 2 | `SOUL.md` | "Your Soul" | File exists |
| 3 | `IDENTITY.md` | "Your Identity" | File exists |
| 4 | `USER.md` | "About Your Human" | File exists |
| 5 | `AGENTS.md` | "Operating Instructions" | File exists |
| 6 | `MEMORY.md` | "Long-Term Memory" | File exists AND session is main session |
| 7 | `memory/{yesterday}.md` | "Recent Context > Yesterday" | File exists |
| 8 | `memory/{today}.md` | "Recent Context > Today" | File exists |
| 9 | `TOOLS.md` | "Tool Notes" | File exists |
| 10 | `HEARTBEAT.md` | "Heartbeats" | File exists and has meaningful content |
| 11 | Skills | "Skills (Mandatory Scan)" | Eligible skills exist |
| 12 | (runtime info) | "Runtime" | Always |

**Bootstrap (first-run) order:**

When `BOOTSTRAP.md` exists, it takes priority. The prompt includes the core scaffold, then `BOOTSTRAP.md` as a commissioning ceremony, followed by `SOUL.md`, `IDENTITY.md`, and `USER.md` if present. Other workspace files are skipped.

### File Descriptions

#### `agents/{agentId}/SOUL.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call |
| Written by | User or agent (via workspace write tool) |

Core values, personality, and behavioral foundations for the agent.

#### `agents/{agentId}/IDENTITY.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call |
| Written by | User or agent |

Name, class designation, emoji, and other identity attributes.

#### `agents/{agentId}/USER.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call |
| Written by | User or agent |

Information about the human user the agent serves.

#### `agents/{agentId}/AGENTS.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call (normal operation only) |
| Written by | User or agent |

Operating instructions and behavioral guidelines.

#### `agents/{agentId}/MEMORY.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call, main session only |
| Written by | User or agent |

Long-term persistent memory. Restricted to main sessions for security — non-main sessions (e.g., DMs from other peers in `per-peer` mode) do not see this file.

#### `agents/{agentId}/TOOLS.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call (normal operation only) |
| Written by | User or agent |

Tool-specific configuration notes and instructions.

#### `agents/{agentId}/HEARTBEAT.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call (when non-empty) |
| Written by | User or agent |

Instructions for heartbeat behavior. The file is considered empty (and skipped) if it contains only whitespace, markdown headers with no body text, HTML comments, or horizontal rules.

#### `agents/{agentId}/BOOTSTRAP.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Read | Every LLM call (while file exists) |
| Written by | User (typically a template) |

First-run commissioning ceremony. When present, overrides the normal prompt assembly order. The agent is expected to complete the commissioning and then delete or rename this file.

## Daily Memory Files

### `agents/{agentId}/memory/{YYYY-MM-DD}.md`

| Property | Value |
|---|---|
| Format | Markdown |
| Path pattern | `agents/{agentId}/memory/YYYY-MM-DD.md` |
| Read | Every LLM call (today's and yesterday's files) |
| Written by | Compaction engine, reset memory extraction, or agent |

Daily memory files accumulate context extracted during session compaction and pre-reset memory extraction.

**Read behavior**: The workspace loader reads two daily memory files:
- Today's date (`YYYY-MM-DD` from server time)
- Yesterday's date

**Write behavior**: Memories are appended with a timestamped section header:

```markdown
### Extracted from context compaction (HH:MM)

<extracted memories>
```

Pre-reset extraction writes to the date of the conversation's last activity (`updatedAt`), not the current date.

## Session Archives

### `agents/{agentId}/sessions/{sessionId}.jsonl.gz`

| Property | Value |
|---|---|
| Format | JSONL, gzip-compressed |
| Written | On session reset (manual or auto) |
| Read | On transcript retrieval |

Contains the complete message history of a session at the time it was reset.

**JSONL format**: Each line is a JSON-serialized message object conforming to the `Message` type from `@mariozechner/pi-ai`. Messages have a `role` field (`user`, `assistant`, or `toolResult`) and role-specific content structures.

Example line (user message):

```json
{"role":"user","content":"Hello","timestamp":1708300000000}
```

Example line (assistant message):

```json
{"role":"assistant","content":[{"type":"text","text":"Hi there!"}],"timestamp":1708300001000}
```

Example line (tool result):

```json
{"role":"toolResult","toolCallId":"call_abc","toolName":"Bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1708300002000}
```

**R2 custom metadata** stored on the object:

| Key | Type | Description |
|---|---|---|
| `sessionKey` | `string` | Session routing key |
| `sessionId` | `string` | UUID of the archived session |
| `agentId` | `string` | Agent identifier |
| `messageCount` | `string` (numeric) | Number of messages in the archive |
| `archivedAt` | `string` (epoch ms) | Timestamp of archival |
| `inputTokens` | `string` (numeric) | Cumulative input tokens at time of reset |
| `outputTokens` | `string` (numeric) | Cumulative output tokens at time of reset |
| `totalTokens` | `string` (numeric) | Cumulative total tokens at time of reset |

### `agents/{agentId}/sessions/{sessionId}-part{timestamp}.jsonl.gz`

| Property | Value |
|---|---|
| Format | JSONL, gzip-compressed |
| Written | During context compaction |
| Read | Not read during normal operation |

Partial archives created when the compaction engine removes older messages from an active session. The `{timestamp}` is `Date.now()` at the time of compaction.

**R2 custom metadata**:

| Key | Type | Description |
|---|---|---|
| `sessionKey` | `string` | Session routing key |
| `sessionId` | `string` | UUID of the active session |
| `agentId` | `string` | Agent identifier |
| `partNumber` | `string` (numeric) | Same as the timestamp suffix |
| `messageCount` | `string` (numeric) | Number of messages in this partial archive |
| `archivedAt` | `string` (epoch ms) | Timestamp of archival |

## Skills

### `agents/{agentId}/skills/{skillName}/SKILL.md`

| Property | Value |
|---|---|
| Format | Markdown with YAML frontmatter |
| Read | Every LLM call (during workspace loading for listing); on-demand when agent loads a skill |
| Written by | User, agent, or deployment tooling |

Agent-local skill definition. Takes precedence over a global skill with the same `{skillName}`.

### `skills/{skillName}/SKILL.md`

| Property | Value |
|---|---|
| Format | Markdown with YAML frontmatter |
| Read | Every LLM call (during workspace loading for listing); on-demand when agent loads a skill |
| Written by | Deployment tooling or admin |

Global skill definition. Used when no agent-local skill with the same name exists.

**Skill resolution order**: Agent-local skills (`agents/{agentId}/skills/`) are listed first. Global skills (`skills/`) are listed second, skipping any name already present from the agent-local set.

See the Skills Frontmatter Reference for the `SKILL.md` file format.

## Media

### `media/{sessionKey}/{uuid}.{ext}`

| Property | Value |
|---|---|
| Format | Binary (original media encoding) |
| Max size | 25 MB |
| Written | On inbound message with media attachment |
| Read | During LLM call (hydrated from r2Key references in messages) |
| Deleted | On session reset |

Media files (images, audio, video, documents) attached to inbound messages or extracted from tool results. Stored as raw binary with the original content type.

**Key construction**: `media/{sessionKey}/{uuid}.{ext}` where `{uuid}` is a `crypto.randomUUID()` and `{ext}` is derived from the MIME type.

**Sources**: Media is stored from two paths:
- **Inbound channel messages**: Images, audio, video, and documents attached to messages from channels (WhatsApp, Discord, etc.).
- **Tool result images**: When a node Read tool returns a structured result containing an `ImageContent` block (e.g., reading an image file from a node's filesystem), the base64 image data is stored in R2 at this path and replaced with an `r2Key` reference, following the same lifecycle as channel media.

**MIME type to extension mapping**:

| MIME Type | Extension |
|---|---|
| `image/jpeg` | `jpg` |
| `image/png` | `png` |
| `image/gif` | `gif` |
| `image/webp` | `webp` |
| `image/svg+xml` | `svg` |
| `audio/ogg` | `ogg` |
| `audio/opus` | `opus` |
| `audio/mpeg` | `mp3` |
| `audio/mp3` | `mp3` |
| `audio/mp4` | `m4a` |
| `audio/m4a` | `m4a` |
| `audio/wav` | `wav` |
| `audio/webm` | `webm` |
| `audio/flac` | `flac` |
| `video/mp4` | `mp4` |
| `video/webm` | `webm` |
| `video/quicktime` | `mov` |
| `application/pdf` | `pdf` |
| `application/msword` | `doc` |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `docx` |
| (other) | `bin` |

**R2 HTTP metadata**:

| Key | Value |
|---|---|
| `contentType` | Original MIME type of the media |

**R2 custom metadata**:

| Key | Type | Description |
|---|---|---|
| `originalFilename` | `string` | Original filename (may be empty) |
| `uploadedAt` | `string` (epoch ms) | Upload timestamp |
| `sessionKey` | `string` | Session routing key |

**Lifecycle**: Media files are stored when an inbound message is processed or when a tool result contains image content. The base64 data is stripped from the in-memory message and replaced with an `r2Key` reference. During LLM calls, references are hydrated back to base64 via an in-memory LRU cache (50 MB budget). On session reset, all media under the `media/{sessionKey}/` prefix is deleted.

## Read/Write Summary

| Path Pattern | Read By | Written By | Lifecycle |
|---|---|---|---|
| `agents/{id}/SOUL.md` | Prompt builder | User/agent | Persistent |
| `agents/{id}/IDENTITY.md` | Prompt builder | User/agent | Persistent |
| `agents/{id}/USER.md` | Prompt builder | User/agent | Persistent |
| `agents/{id}/AGENTS.md` | Prompt builder | User/agent | Persistent |
| `agents/{id}/MEMORY.md` | Prompt builder (main session) | User/agent | Persistent |
| `agents/{id}/TOOLS.md` | Prompt builder | User/agent | Persistent |
| `agents/{id}/HEARTBEAT.md` | Prompt builder | User/agent | Persistent |
| `agents/{id}/BOOTSTRAP.md` | Prompt builder | User/template | Deleted after commissioning |
| `agents/{id}/memory/{date}.md` | Prompt builder (today + yesterday) | Compaction/reset/agent | Accumulates daily |
| `agents/{id}/sessions/{sid}.jsonl.gz` | Transcript retrieval | Reset handler | One per reset |
| `agents/{id}/sessions/{sid}-part{ts}.jsonl.gz` | Not read in normal operation | Compaction engine | One per compaction |
| `agents/{id}/skills/{name}/SKILL.md` | Skill lister + agent on-demand | User/agent/deploy | Persistent |
| `skills/{name}/SKILL.md` | Skill lister + agent on-demand | Deploy tooling | Persistent |
| `media/{sessionKey}/{uuid}.{ext}` | LLM call (hydration) | Inbound media processor, tool result image storage | Deleted on session reset |
