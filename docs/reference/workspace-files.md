# Workspace Files Reference

Each agent's workspace is stored in R2 at the path `agents/{agentId}/`. Workspace files are loaded by `loadAgentWorkspace()` (defined in `gateway/src/agents/loader.ts`) and assembled into the system prompt by `buildSystemPromptFromWorkspace()` (defined in `gateway/src/agents/prompt.ts`).

Default templates for workspace files are in `templates/workspace/`.

---

## R2 Storage Layout

```
agents/{agentId}/
├── AGENTS.md
├── SOUL.md
├── IDENTITY.md
├── USER.md
├── MEMORY.md
├── TOOLS.md
├── HEARTBEAT.md
├── BOOTSTRAP.md
├── memory/
│   ├── {YYYY-MM-DD}.md      (today)
│   └── {YYYY-MM-DD}.md      (yesterday)
└── skills/
    └── {skillName}/
        └── SKILL.md
```

---

## File Loading Behavior

All core workspace files are loaded in parallel from R2. A file is considered to exist only if the R2 object is found; missing files are omitted from the workspace (their `WorkspaceFile` is `undefined`).

### Conditional Loading

| File | Condition |
|------|-----------|
| `MEMORY.md` | Loaded only when `isMainSession` is `true`. This restricts personal context to direct conversations with the human and prevents leakage to shared contexts (group chats, Discord, sessions with other people). |
| `memory/{YYYY-MM-DD}.md` (today) | Always loaded when present. Date is computed from `new Date()` at load time. |
| `memory/{YYYY-MM-DD}.md` (yesterday) | Always loaded when present. Date is today minus one day. |
| Skills list | Always loaded. Calls `listWorkspaceSkills()` to discover available skills. |

All other core files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`) are loaded unconditionally when present.

---

## System Prompt Assembly Order

The system prompt is built by concatenating sections separated by `\n\n---\n\n`. Empty sections are filtered out. The order depends on whether `BOOTSTRAP.md` exists.

### Normal Operation (no BOOTSTRAP.md)

| Order | Section | Source |
|-------|---------|--------|
| 1 | Base prompt | `systemPrompt` config or default: `"You are a helpful AI assistant running inside GSV."` |
| 2 | Tooling | Generated from runtime tool list. Lists native and node tool counts and names. |
| 3 | Tool Call Style | Static instructions for tool narration behavior. |
| 4 | Safety | Static safety constraints (no self-preservation, no safeguard bypass). |
| 5 | Workspace | Static description of agent workspace root and skill path resolution. |
| 6 | Workspace Files | Static description of which files are injected. |
| 7 | `## Your Soul` | `SOUL.md` content, if file exists. |
| 8 | `## Your Identity` | `IDENTITY.md` content, if file exists. |
| 9 | `## About Your Human` | `USER.md` content, if file exists. |
| 10 | `## Operating Instructions` | `AGENTS.md` content, if file exists. |
| 11 | `## Long-Term Memory` | `MEMORY.md` content, if file exists and this is the main session. |
| 12 | `## Recent Context` | Yesterday's and today's daily memory, as `### Yesterday` and `### Today` subsections. |
| 13 | `## Tool Notes` | `TOOLS.md` content, if file exists. |
| 14 | `## Heartbeats` | Heartbeat section. Included when a heartbeat prompt is configured or `HEARTBEAT.md` has meaningful content. Contains the static `HEARTBEAT_OK` instruction, the configured heartbeat prompt (if any), and the `HEARTBEAT.md` content (if non-empty). |
| 15 | `## Skills (Mandatory Scan)` | Generated skills listing. Included when eligible skills exist. |
| 16 | `## Runtime` | Runtime metadata: agent ID, session type, session key, model, timezone, channel, connected hosts. |

### First Run (BOOTSTRAP.md exists)

When `BOOTSTRAP.md` is present, the prompt prioritizes the commissioning ceremony:

| Order | Section | Source |
|-------|---------|--------|
| 1 | Base prompt | Same as normal. |
| 2 | Tooling | Same as normal. |
| 3 | Tool Call Style | Same as normal. |
| 4 | Safety | Same as normal. |
| 5 | Workspace | Same as normal. |
| 6 | Workspace Files | Same as normal. |
| 7 | `## COMMISSIONING CEREMONY (First Run)` | `BOOTSTRAP.md` content, with a preamble instructing the agent to follow the ceremony before doing anything else. |
| 8 | `## Current Soul (update during commissioning)` | `SOUL.md` content, if file exists. |
| 9 | `## Current Identity (fill in during commissioning)` | `IDENTITY.md` content, if file exists. |
| 10 | `## About Your Human` | `USER.md` content, if file exists. |
| 11 | `## Heartbeats` | Same conditional logic as normal. |
| 12 | `## Runtime` | Same as normal. |

During first run, `AGENTS.md`, `MEMORY.md`, daily memory, `TOOLS.md`, and skills are not included.

---

## SOUL.md

**Purpose:** Defines the agent's core personality, values, and behavioral principles.

**R2 path:** `agents/{agentId}/SOUL.md`

**Prompt section heading:** `## Your Soul` (normal) or `## Current Soul (update during commissioning)` (first run)

**Included when:** File exists in R2.

**Loaded in:** Both main and non-main sessions.

### Default Template

The default template establishes:
- Behavioral directives: be genuinely helpful, have opinions, be resourceful before asking, earn trust through competence.
- Boundaries: privacy, ask before external actions, never send half-baked replies.
- Tone guidance: concise when needed, thorough when it matters.
- Continuity note: workspace files are the agent's persistent memory across sessions.

The agent is expected to evolve this file over time and inform the user when changes are made.

---

## IDENTITY.md

**Purpose:** Stores the agent's name, personality descriptor, signature emoji, and optional avatar.

**R2 path:** `agents/{agentId}/IDENTITY.md`

**Prompt section heading:** `## Your Identity` (normal) or `## Current Identity (fill in during commissioning)` (first run)

**Included when:** File exists in R2.

**Loaded in:** Both main and non-main sessions.

### Default Template

The default template contains placeholder fields:
- **Name:** (Culture ship naming convention suggested)
- **Vibe:** (personality descriptor)
- **Emoji:** (signature emoji)
- **Avatar:** (workspace-relative path, URL, or data URI — optional)

Intended to be filled in during the commissioning ceremony.

---

## USER.md

**Purpose:** Stores information about the human the agent is assisting.

**R2 path:** `agents/{agentId}/USER.md`

**Prompt section heading:** `## About Your Human`

**Included when:** File exists in R2.

**Loaded in:** Both main and non-main sessions.

### Default Template

The default template contains placeholder fields:
- **Name**
- **What to call them**
- **Pronouns** (optional)
- **Timezone**
- **Notes**
- **Context** section for ongoing details about the user's interests, projects, and preferences.

---

## MEMORY.md

**Purpose:** Curated long-term memory. Contains significant insights, decisions, opinions, and learnings that persist across sessions.

**R2 path:** `agents/{agentId}/MEMORY.md`

**Prompt section heading:** `## Long-Term Memory`

**Included when:** File exists in R2 **and** the session is the main session (`isMainSession` is `true`).

**Loaded in:** Main session only. Excluded from non-main sessions (group chats, DMs with other people) for security — prevents personal context leakage.

### Default Template

The default template is a stub with a comment placeholder. The agent is expected to populate it with curated information over time, distinct from raw daily logs.

---

## AGENTS.md

**Purpose:** Operating instructions for the agent. Covers session startup behavior, architecture context, memory management, safety rules, external action guidelines, group chat behavior, heartbeat usage, and platform formatting.

**R2 path:** `agents/{agentId}/AGENTS.md`

**Prompt section heading:** `## Operating Instructions`

**Included when:** File exists in R2. Not included during first run (when `BOOTSTRAP.md` exists).

**Loaded in:** Both main and non-main sessions.

### Default Template

The default template covers:
- **First Run:** Instructions to follow `BOOTSTRAP.md` if present.
- **Every Session:** Checklist to read `SOUL.md`, `IDENTITY.md`, `USER.md`, daily memory, and `MEMORY.md` (main session only).
- **Architecture:** Explanation of Gateway, Nodes, Workspace, and tool namespacing (`{nodeId}__toolname`, `gsv__*`).
- **Memory:** Daily notes (`memory/YYYY-MM-DD.md`) and long-term memory (`MEMORY.md`). Emphasis on writing things down rather than relying on in-context memory.
- **Safety:** No data exfiltration, no destructive commands without asking, prefer `trash` over `rm`.
- **External vs Internal:** Free to read/explore/organize internally; ask before sending external communications.
- **Group Chats:** Guidelines for when to speak and when to stay silent.
- **Heartbeats:** Guidance on proactive use of heartbeat polls (check emails, calendar, mentions) vs. staying quiet.
- **Platform Formatting:** Channel-specific formatting rules (no tables on Discord/WhatsApp, link wrapping on Discord, no headers on WhatsApp).

---

## TOOLS.md

**Purpose:** Environment-specific tool notes. Stores local configuration details that help the agent use tools effectively (camera names, SSH hosts, TTS voices, device nicknames, etc.).

**R2 path:** `agents/{agentId}/TOOLS.md`

**Prompt section heading:** `## Tool Notes`

**Included when:** File exists in R2. Not included during first run.

**Loaded in:** Both main and non-main sessions.

### Default Template

The default template provides examples of what to store: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames. Also describes tool namespacing for node tools.

---

## HEARTBEAT.md

**Purpose:** Checklist or reminders for the agent to process during heartbeat polls. When this file has meaningful content, it is included in the heartbeat section of the system prompt.

**R2 path:** `agents/{agentId}/HEARTBEAT.md`

**Prompt section heading:** Appears as `### HEARTBEAT.md` within the `## Heartbeats` section.

**Included when:** File exists in R2 and has meaningful content (see emptiness check below), or when a heartbeat prompt is configured.

**Loaded in:** Both main and non-main sessions.

### Emptiness Check

`isHeartbeatFileEmpty()` determines whether the file has meaningful content. The file is considered empty if, after removing HTML comments (`<!-- ... -->`), all remaining lines are:
- Empty or whitespace-only
- Markdown headers with no content (e.g. `# `, `## `)
- Header underline characters only (`---`, `===`)

### Default Template

The default template contains only HTML comments instructing the user to keep it empty to skip heartbeat actions and add tasks when periodic checks are desired.

---

## BOOTSTRAP.md

**Purpose:** First-run commissioning ceremony. Guides the agent through establishing its identity, name, personality, and initial workspace setup. Its presence in R2 signals that the agent has not yet been commissioned.

**R2 path:** `agents/{agentId}/BOOTSTRAP.md`

**Prompt section heading:** `## COMMISSIONING CEREMONY (First Run)`

**Included when:** File exists in R2. When present, the prompt assembly switches to first-run mode, which changes section ordering and excludes `AGENTS.md`, `MEMORY.md`, daily memory, `TOOLS.md`, and skills.

**Loaded in:** Both main and non-main sessions.

**Lifecycle:** The agent is expected to delete `BOOTSTRAP.md` after completing the commissioning ceremony using `gsv__DeleteFile`.

### Default Template

The default template defines a conversational commissioning flow:
1. The agent introduces itself as a new Mind without identity.
2. Together with the user, determine: name (Culture ship naming convention), vibe/personality, and signature emoji.
3. After identity is established, write `IDENTITY.md`, `SOUL.md`, and `USER.md` using workspace tools.
4. Ask about the user's preferences and boundaries.
5. Delete `BOOTSTRAP.md` when complete.

---

## Daily Memory Files

**Purpose:** Raw daily logs of events, decisions, and context.

**R2 paths:**
- `agents/{agentId}/memory/{YYYY-MM-DD}.md` (today)
- `agents/{agentId}/memory/{YYYY-MM-DD}.md` (yesterday)

**Prompt section heading:** `## Recent Context` containing `### Yesterday` and `### Today` subsections.

**Included when:** Either or both files exist in R2. Not included during first run.

**Loaded in:** Both main and non-main sessions.

**Date computation:** `getDateString()` uses `new Date()` with day offset. Today is offset `0`, yesterday is offset `-1`. Format is `YYYY-MM-DD` from `toISOString().split("T")[0]`.

---

## Skills

**Purpose:** Loadable capability modules stored as `SKILL.md` files.

**R2 paths:**
- Agent-level: `agents/{agentId}/skills/{skillName}/SKILL.md`
- Global: `skills/{skillName}/SKILL.md`

Skills are not workspace files in the same sense as the core files above. They are discovered via `listWorkspaceSkills()` and rendered into the `## Skills (Mandatory Scan)` prompt section when eligible skills exist. Agent-level skill files override global skill files of the same name.

Skills are read on demand by the agent using the `gsv__ReadFile` tool with a virtual path of `skills/{skillName}/SKILL.md`.
