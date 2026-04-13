# Context and Knowledge Architecture

This document defines the durable information model for GSV processes. The goal is to make long-lived agent knowledge feel like a natural extension of Linux: inspectable files, mounted storage, search over text, explicit scope boundaries, and stable command surfaces.

## Design principles

- Durable knowledge is represented as files in repos, not hidden opaque state.
- Different scopes must stay sharp: standing context, durable knowledge, and workspace task continuity are not the same thing.
- Prompt assembly is a provider pipeline over explicit information systems.
- Compaction maintains active workspace continuity. It does not silently rewrite durable home knowledge.
- Search, history, and diffs matter. Textual durable knowledge should be ripgit-backed by default.
- User-facing paths should stay simple and Linux-like even when the underlying filesystem implementation mounts different storage backends by prefix.
- The knowledge substrate should be generic. GSV should not hardcode semantic kinds like `person` or `project` into the core storage model.

## Filesystem and storage model

Home does not need a single backing store. GSV mounts by path prefix.

Typical example:

- `~/Downloads`, `~/Pictures`, large user blobs
  - R2/blob-backed
- `~/CONSTITUTION.md`
- `~/context.d/`
- `~/knowledge/`
  - ripgit-backed home knowledge repo

This allows large personal files to stay blob-backed while durable textual knowledge stays searchable, diffable, and versioned.

## Information layers

### `~/CONSTITUTION.md`

Purpose:
- Stable identity and standing behavioral rules.

Characteristics:
- User-global.
- Always loaded into prompt assembly.
- First-class path, distinct from `context.d`.
- Explicit edits only.

Good content:
- Standing priorities.
- Stable behavior rules.
- Long-lived communication preferences.
- Identity-defining constraints.

Not for:
- Volatile task notes.
- Large knowledge dumps.
- Automatically accumulated sludge.

### `~/context.d/*.md`

Purpose:
- Small curated always-loaded notes.

Characteristics:
- User-global.
- Always loaded within a configured budget.
- Plain filesystem semantics.
- Curated rather than autonomous.

Good content:
- Current life or work context.
- Pinned preferences.
- Small reference notes.
- Near-term priorities.

Not for:
- Large archives.
- Hidden agent-written knowledge accumulation.
- Semantic database operations.

### `~/knowledge/`

Purpose:
- Durable home knowledge.

Characteristics:
- User-global.
- Ripgit-backed.
- Generic substrate for both personal/entity knowledge and domain/topic knowledge.
- Retrieved selectively; not fully loaded every turn.
- Organized by path and optional schema, not by hardcoded runtime enums.

Good content:
- Facts about the user and their preferences.
- Notes about people, projects, organizations, and places.
- Topic and product knowledge.
- Research notes.
- Compiled wiki pages.
- Source-grounded summaries.
- Candidate promotions waiting for review.

### `/workspaces/{id}/.gsv/*`

Purpose:
- Active workspace continuity.

Characteristics:
- Workspace-local.
- Used by compaction and checkpoint.
- Auto-maintained.
- Always relevant to that workspace, but distinct from user-global durable knowledge.

Good content:
- `summary.md`
- `open-loops.md`
- `decisions.md`
- checkpoint metadata
- transcript archive pointers

Not for:
- Durable home knowledge.
- Standing identity rules.

## Canonical home layout

```text
~/
├── CONSTITUTION.md
├── context.d/
│   ├── communication.md
│   ├── priorities.md
│   └── current-context.md
└── knowledge/
    ├── self/
    │   ├── profile.md
    │   ├── preferences.md
    │   └── goals.md
    ├── people/
    │   ├── alice.md
    │   └── bob.md
    ├── projects/
    ├── orgs/
    ├── places/
    ├── topics/
    ├── product/
    ├── research/
    ├── inbox/
    ├── index.md
    └── SCHEMA.md
```

The directory names above are conventions, not hard requirements. Users and apps may create additional knowledge subtrees.

## Canonical workspace layout

```text
/workspaces/{id}/.gsv/
├── summary.md
├── open-loops.md
├── decisions.md
├── checkpoint.json
└── chat.jsonl
```

## Surface model

### Plain filesystem surface

`~/CONSTITUTION.md` and `~/context.d/*` use normal filesystem operations.

Why:
- They are intentionally simple.
- They are curated notes, not semantic databases.
- They should remain editable with normal tools and shell workflows.

This means:
- source of truth is files
- manipulation uses `fs.*`, editors, and shell tools

A `ctx` command is still useful, but it should be a convenience wrapper over filesystem operations rather than a new syscall domain.

### Unified knowledge surface

`~/knowledge/` gets one dedicated semantic syscall domain: `knowledge.*`.

Why:
- Search, promotion, merge, ingestion, compilation, indexing, and retrieval are semantic operations.
- Those operations are equally useful for personal/entity knowledge and domain/topic knowledge.
- The substrate should stay generic instead of splitting into a separate `memory.*` and `knowledge.*` layer that would duplicate functionality.

This means:
- source of truth is still markdown files in `~/knowledge/`
- `knowledge.*` adds semantic operations over that tree
- `mem` and `wiki` are CLI/personality wrappers over the same syscall family

## Prompt assembly contract

Prompt assembly should understand these information systems explicitly.

Always-loaded layers:
- base system prompt
- profile instructions
- `~/CONSTITUTION.md`
- `~/context.d/*.md` within budget
- workspace `.gsv/summary.md`
- workspace `.gsv/open-loops.md`

Retrieved layers:
- archived transcript material

The process prompt should explain:
- what each layer is for
- which layers are always loaded versus selectively retrieved
- that `context.d` is curated
- that workspace `.gsv/*` is task-local continuity
- that durable promotions into `~/knowledge/` should be deliberate
- that `~/knowledge/` is accessed explicitly through tools and commands rather than injected wholesale into the prompt

## Write policy

There are three write classes.

### Explicit writes

User explicitly asked for the write.

Applies to:
- `CONSTITUTION.md`
- `context.d/*`
- knowledge edits

### Guided writes

The model proposes a concrete write and the user or policy approves it.

Good fits:
- high-value home knowledge notes
- edits to entity-like notes under `~/knowledge/people/`, `~/knowledge/self/`, `~/knowledge/projects/`
- structural changes to important wiki pages

### Automatic writes

Only safe housekeeping and task continuity.

Good fits:
- workspace `.gsv/*`
- `~/knowledge/index.md`
- `~/knowledge/inbox/*`
- database-local index or log files under `~/knowledge/*`

Automatic writes should not turn `context.d` into a dump target.

## Compaction boundary

Compaction is not the knowledge system.

Compaction updates workspace-local active continuity:
- `.gsv/summary.md`
- `.gsv/open-loops.md`
- `.gsv/decisions.md`

Compaction may emit promotion candidates for:
- durable user facts
- notes about people/projects/orgs/topics
- knowledge-base updates

But compaction should not directly and silently rewrite:
- `~/CONSTITUTION.md`
- `~/context.d/*`
- canonical durable knowledge notes

This keeps the boundary sharp:
- compaction maintains active task state
- promotion updates durable home knowledge

## Retrieval philosophy

Start with ripgit-backed text search and repo traversal.

Do not start with vector infrastructure.

Desired properties:
- inspectable files
- searchable markdown
- diffs and history
- explicit provenance where useful
- deterministic prompt providers

## Inbox and promotion

`~/knowledge/inbox/` is a staging area for candidate durable knowledge that is not yet trusted enough to become canonical.

Why it exists:
- many conversational facts are tentative, ambiguous, or low-confidence
- compaction and retrieval may surface important candidates without enough certainty to rewrite canonical notes directly

Examples:
- a tentative preference about the user
- a possible fact about a person that might be wrong
- a proposed update to a project note
- a candidate wiki page or summary from a source ingest

Recommended shape:
- one file per candidate under `~/knowledge/inbox/`
- not one giant append-only inbox file

That makes review, promotion, diffing, and cleanup easier.

Promotion means:
- taking a candidate or other source material
- resolving where it belongs in `~/knowledge/`
- writing it directly into a canonical note or page when policy allows
- otherwise leaving it in inbox for review

## Merge semantics

`knowledge.merge` is for consolidating overlapping notes that represent the same thing.

Examples:
- `~/knowledge/people/alice.md`
- `~/knowledge/people/alice-smith.md`

or:
- two project notes that should become one canonical page

Merge means:
- choose a canonical survivor
- move useful aliases, facts, links, evidence, and metadata into it
- optionally leave a tombstone or redirect note at the old path

Without merge, retrieval quality degrades over time due to duplication and fragmentation.

## `knowledge.*` syscall surface

`knowledge.*` manages durable home knowledge rooted at `~/knowledge/`.

The source of truth is a repo-backed directory tree. The syscall layer exists because the knowledge tree needs search, promotion, merge, ingestion, compilation, indexing, and synthesized retrieval.

### Path rules

- All paths are relative to `~/knowledge/`.
- Paths are generic. The runtime does not hardcode semantic kinds.
- Well-known conventions such as `self/`, `people/`, `projects/`, `topics/`, `product/`, `research/`, and `inbox/` are useful defaults, not enforced schema.
- Leaf notes should generally be markdown files.

### File shape

Knowledge files should remain human-editable markdown.

Recommended shape:

```md
---
title: Alice Smith
aliases: ["Alice"]
tags: ["friend", "design"]
updated_at: 2026-04-12T10:00:00Z
---

# Alice Smith

## Summary
Short durable summary.

## Facts
- Prefers concise replies.
- Works in product design.

## Evidence
- 2026-04-11: said she prefers concise replies in WhatsApp.
```

Optional schemas or local conventions may add structure, but the canonical artifact is still the markdown file.

### `knowledge.list`

Purpose:
- List files and directories under `~/knowledge/`.

Args:
```ts
{
  prefix?: string;
  recursive?: boolean;
  limit?: number;
}
```

Result:
```ts
{
  entries: Array<{
    path: string;
    kind: "file" | "dir";
    title?: string;
    updatedAt?: string;
  }>;
}
```

### `knowledge.read`

Purpose:
- Read one knowledge note or file by path.

Args:
```ts
{
  path: string;
}
```

Result:
```ts
{
  path: string;
  exists: boolean;
  title?: string;
  frontmatter?: Record<string, unknown>;
  markdown?: string;
}
```

### `knowledge.write`

Purpose:
- Create or update one knowledge note.

Args:
```ts
{
  path: string;
  mode?: "replace" | "merge" | "append";
  markdown?: string;
  patch?: {
    title?: string;
    summary?: string;
    addFacts?: string[];
    addPreferences?: string[];
    addEvidence?: string[];
    addAliases?: string[];
    addTags?: string[];
    addLinks?: string[];
  };
  create?: boolean;
}
```

Rules:
- `markdown` is for explicit whole-note writes.
- `patch` is for semantic updates without replacing the whole file.
- `mode="merge"` should merge sections and de-duplicate simple bullet entries where possible.

Result:
```ts
{
  ok: true;
  path: string;
  created: boolean;
  updated: boolean;
}
```

### `knowledge.search`

Purpose:
- Text search over `~/knowledge/`.

Args:
```ts
{
  query: string;
  prefix?: string;
  limit?: number;
}
```

Result:
```ts
{
  matches: Array<{
    path: string;
    title?: string;
    snippet: string;
    score?: number;
  }>;
}
```

Behavior:
- deterministic search over titles, aliases, tags, and body text
- no synthesis

### `knowledge.merge`

Purpose:
- Merge duplicate or overlapping knowledge notes.

Args:
```ts
{
  sourcePath: string;
  targetPath: string;
  mode?: "prefer-target" | "prefer-source" | "union";
  keepSource?: boolean;
}
```

Result:
```ts
{
  ok: true;
  targetPath: string;
  sourcePath: string;
  removedSource: boolean;
}
```

Behavior:
- add aliases, links, evidence, tags, and compatible sections from source into target
- preserve provenance where practical
- if `keepSource=false`, implementation may create a tombstone or redirect note instead of hard deletion

### `knowledge.promote`

Purpose:
- Promote candidate durable knowledge into canonical notes.

Args:
```ts
{
  source:
    | { kind: "text"; text: string }
    | { kind: "candidate"; path: string }
    | { kind: "process"; pid: string; runId?: string; messageIds?: number[] };
  targetPath?: string;
  mode?: "inbox" | "direct";
}
```

Result:
```ts
{
  ok: true;
  path: string;
  created: boolean;
  requiresReview: boolean;
}
```

Behavior:
- `mode="inbox"` writes a candidate note under `~/knowledge/inbox/`
- `mode="direct"` writes or patches a target note directly
- if direct resolution is ambiguous, the runtime should downgrade to inbox rather than guess

### `knowledge.ingest`

Purpose:
- Ingest raw source material into `~/knowledge/`.

Args:
```ts
{
  pathPrefix?: string;
  source:
    | { kind: "text"; text: string; filename: string }
    | { kind: "file"; path: string }
    | { kind: "url"; url: string; filename?: string };
  note?: string;
}
```

Result:
```ts
{
  ok: true;
  path: string;
  created: boolean;
}
```

Behavior:
- useful for source-heavy knowledge subtrees such as `research/` or `product/`
- stores the original artifact under the requested area
- may append provenance notes or logs when conventions exist
- does not imply compilation unless requested separately

### `knowledge.compile`

Purpose:
- Compile or refresh higher-level notes from raw or existing knowledge material.

Args:
```ts
{
  targetPath: string;
  sources?: string[];
  mode?: "create" | "update" | "reconcile";
}
```

Result:
```ts
{
  ok: true;
  updatedPaths: string[];
}
```

Behavior:
- useful for source-heavy wiki-like areas
- optional for simpler personal/entity notes
- should preserve provenance and append logs when conventions exist

### `knowledge.query`

Purpose:
- Retrieve and synthesize a compact answer over home knowledge.

Args:
```ts
{
  query: string;
  prefixes?: string[];
  limit?: number;
  maxBytes?: number;
}
```

Result:
```ts
{
  brief: string;
  refs: Array<{
    path: string;
    title?: string;
  }>;
}
```

Behavior:
- this is the retrieval surface for prompt assembly and agents
- it should synthesize over selected notes, not dump full files by default
- prefixes can narrow between entity-like areas and source-heavy areas

### `knowledge.reindex`

Purpose:
- Refresh index or helper artifacts under a subtree.

Args:
```ts
{
  prefix?: string;
}
```

Result:
```ts
{
  ok: true;
  updatedPaths: string[];
}
```

Behavior:
- rebuilds maintained index helper files when conventions exist
- does not replace source content

## CLI wrappers

### `ctx`

Purpose:
- convenience wrapper over `fs.*` for `~/CONSTITUTION.md` and `~/context.d/*`

### `mem`

Purpose:
- opinionated UX over `knowledge.*` for personal/entity-oriented subtrees such as:
  - `self/`
  - `people/`
  - `projects/`
  - `orgs/`
  - `places/`

Examples:

```bash
mem list people/
mem show people/alice.md
mem search "concise replies"
mem note people/alice.md "Prefers concise replies"
mem promote --from-process $PID
mem merge people/alice-smith.md people/alice.md
mem query "What should I remember about Alice before replying?"
```

### `wiki`

Purpose:
- opinionated UX over `knowledge.*` for topic- and source-heavy subtrees such as:
  - `product/`
  - `research/`
  - `topics/`

Examples:

```bash
wiki list
wiki ingest product ./spec.md
wiki search product "auth token"
wiki show product/auth-overview.md
wiki update product/auth-overview.md
wiki compile product/auth-overview.md --from product/raw/spec.md
wiki query "How does auth work?" --prefix product/
wiki reindex product/
```

## Locked-in decisions

- `~/CONSTITUTION.md` remains a first-class path.
- `~/context.d/*` remains plain filesystem content, not a dedicated syscall domain.
- `~/knowledge/` is the single ripgit-backed durable home knowledge substrate.
- There is no separate `memory.*` domain.
- `mem` and `wiki` are two views and CLI wrappers over the same `knowledge.*` substrate.
- The runtime does not hardcode semantic kinds into the knowledge substrate.
- Workspace `.gsv/*` is for compaction and continuity, not general durable home knowledge.

## Next design steps

1. Define provider behavior for always-loaded and retrieval-backed layers.
2. Define promotion flow from compaction into `~/knowledge/`.
3. Implement the mounted home-knowledge repo and migrate prompt assembly to it.
4. Add `knowledge.*` syscalls and the `mem` and `wiki` shell wrappers.

## Provider model

Prompt assembly should separate always-loaded context from retrieval-backed context.

These are different jobs:
- always-loaded context defines standing rules and active workspace continuity
- retrieval-backed context injects narrow relevant knowledge for the current task or user message

GSV should not treat all knowledge as one giant system prompt blob.

### Provider classes

#### 1. Static providers

Static providers are deterministic and unconditional for a given process identity and workspace.

They feed the assembled system prompt.

Initial static provider plan:
- `base.system_prompt`
- `profile.instructions`
- `home.constitution`
- `home.context`
- `workspace.summary`
- `workspace.open_loops`

Notes:
- `home.constitution` reads `~/CONSTITUTION.md`
- `home.context` reads `~/context.d/*.md`, sorted alphabetically and budgeted
- `workspace.summary` reads `/workspaces/{id}/.gsv/summary.md`
- `workspace.open_loops` reads `/workspaces/{id}/.gsv/open-loops.md`

`workspace.decisions` should not be always-loaded by default. It is better treated as retrieval-backed or summarized into the workspace summary.

#### 2. Retrieval providers

Retrieval providers are conditional and run-specific.

They should execute after the current user message is known and before the model call is assembled.

They feed transient context blocks for the current turn, not the permanent system prompt.

Initial retrieval provider plan:
- `workspace.history`
- `archive.history` (later)

`workspace.history` should retrieve narrow relevant workspace history or artifacts when needed.

`archive.history` can come later once transcript archives move into the knowledge substrate or another searchable archive surface.

`~/knowledge/` is intentionally not a retrieval provider in the default prompt path. Home knowledge should be accessed explicitly through `knowledge.*` syscalls or the `mem` / `wiki` command surface so the access pattern stays inspectable and Linux-like.

### Prompt composition

The prompt should be assembled in two stages.

#### Stage 1: static system prompt

Build a stable system prompt string from static providers:
- base instructions
- profile instructions
- constitution
- curated context
- workspace continuity

This should remain relatively small and stable.

#### Stage 2: transient retrieved context

Build retrieval-backed context after the current input is known.

This should produce one or more explicit context blocks such as:
- `Relevant home knowledge`
- `Relevant workspace history`
- `Relevant archived context`

These blocks should be injected as structured context near the current turn, not baked into the standing system prompt.

Home knowledge should generally not be auto-injected this way. The preferred path is explicit tool use whose stdout becomes part of the turn context.

### Budgeting

Budgets should be enforced separately.

Recommended initial split:
- static prompt budget
- retrieval budget
- transcript budget

That avoids the current failure mode where always-loaded context crowds out the actually relevant retrieved knowledge.

### Determinism and inspectability

Provider output should be inspectable.

That means:
- provider names should be explicit
- refs returned by retrieval providers should be traceable to file paths
- retrieved knowledge should be bounded and summarized
- prompt assembly should be reproducible enough to explain why a note was included

## Promotion flow

Promotion is how information moves from transient process experience into durable home knowledge.

### Sources of promotion candidates

Candidates can come from:
- compaction
- explicit user requests
- explicit agent requests
- source ingestion and compilation flows
- manual creation by the user

### Automatic output from compaction

Compaction may emit promotion candidates, but it should not directly rewrite canonical notes.

Default compaction outputs:
- `/workspaces/{id}/.gsv/summary.md`
- `/workspaces/{id}/.gsv/open-loops.md`
- `/workspaces/{id}/.gsv/decisions.md`

Optional automatic durable output:
- candidate files under `~/knowledge/inbox/`

This is acceptable because inbox is not canonical knowledge. It is a staging area.

### Candidate file shape

Candidate notes in `~/knowledge/inbox/` should be markdown with explicit provenance.

Recommended shape:

```md
---
source_kind: process
source_pid: 1234
source_workspace: ws_abc123
source_run_id: run_123
candidate_reason: compacted-fact
created_at: 2026-04-12T10:00:00Z
suggested_target: people/alice.md
confidence: medium
---

# Candidate: Alice prefers concise replies

## Proposed knowledge
- Alice prefers concise replies.

## Why this matters
Useful when responding to Alice in chat.

## Evidence
- 2026-04-11 WhatsApp thread: user said Alice prefers concise replies.
```

This keeps promotion review inspectable.

### Promotion modes

`knowledge.promote` supports two modes.

#### `inbox`

Default.

Behavior:
- write a candidate note under `~/knowledge/inbox/`
- do not mutate canonical notes
- return `requiresReview=true`

Use when:
- the fact is tentative
- the target is ambiguous
- promotion was triggered automatically
- policy is conservative

#### `direct`

Behavior:
- write or patch a canonical note directly
- only when target resolution is clear and policy allows it

Use when:
- the user explicitly asked to remember something
- the target path is explicit
- the knowledge update is unambiguous and durable

If direct resolution is ambiguous, the runtime should downgrade to inbox rather than guess.

### Review and approval

Promotion policy should eventually support:
- automatic inbox writes
- guided direct writes with approval
- explicit direct writes

A good first policy model is:
- inbox writes may be automatic
- direct writes require either explicit user request or policy approval

### Merge and cleanup

Inbox review should support:
- promote candidate into canonical note
- merge candidate into existing note
- discard candidate
- rewrite candidate before promotion

That means candidate files are first-class review artifacts, not temporary hidden records.

## Implementation plan

### Phase 1: home knowledge repo mount

- mount a ripgit-backed home knowledge repo into:
  - `~/CONSTITUTION.md`
  - `~/context.d/`
  - `~/knowledge/`
- keep other home prefixes independently mounted as needed
- migrate current R2-backed constitution/context reads to the mounted repo path

### Phase 2: prompt provider split

- keep current static provider model for system prompt assembly
- add retrieval providers as a second stage before generation
- teach the process prompt about constitution, context, knowledge, and workspace continuity
- introduce separate budgets for static context, retrieved knowledge, and transcript
- keep `~/knowledge/` out of the default prompt path; it should be accessed explicitly through tools

### Phase 3: `knowledge.*` kernel surface

- add syscall types and constants
- add kernel handlers and repo wrapper for knowledge operations
- implement:
  - `knowledge.list`
  - `knowledge.read`
  - `knowledge.write`
  - `knowledge.search`
  - `knowledge.merge`
  - `knowledge.promote`
  - `knowledge.query`
- leave ingest/compile/reindex as the next slice if needed

### Phase 4: shell wrappers and UX

- add `ctx` as convenience over filesystem operations
- add `mem` as a personal/entity-oriented wrapper over `knowledge.*`
- add `wiki` as a topic/source-oriented wrapper over `knowledge.*`
- add app surfaces later if helpful

### Phase 5: compaction and promotion integration

- extend compaction to update workspace continuity files
- emit candidate promotion notes under `~/knowledge/inbox/`
- add review and guided-promotion flows
- later, add richer retrieval over inbox and archives
