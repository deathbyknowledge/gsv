# Skills Frontmatter Reference

Skills are markdown files (`SKILL.md`) with YAML frontmatter that define loadable capabilities for GSV agents. The system parses skill files from R2, evaluates eligibility against runtime conditions, and injects eligible skills into the agent's system prompt.

## File Structure

A skill file consists of two parts separated by YAML frontmatter delimiters:

```
---
<frontmatter fields>
---
<markdown body>
```

The frontmatter is delimited by `---` on its own line. The parser normalizes `\r\n` and `\r` to `\n` before processing. If no frontmatter delimiters are found, the entire file is treated as body content with an empty frontmatter object.

The markdown body contains the skill's instructions. It is served verbatim to the agent when the skill is loaded via the workspace read tool.

## File Location

Skills are stored in R2 at two levels. Agent-local skills take precedence over global skills with the same name.

| Scope | R2 Path | Description |
|---|---|---|
| Agent-local | `agents/{agentId}/skills/{skillName}/SKILL.md` | Per-agent skill override |
| Global | `skills/{skillName}/SKILL.md` | Shared across all agents |

The `{skillName}` is derived from the directory name containing `SKILL.md`. When listing skills, agent-local skills are loaded first; global skills are loaded only if no agent-local skill with the same name exists.

## Frontmatter Fields

### `name`

| Property | Value |
|---|---|
| Type | `string` |
| Required | No |
| Default | Directory name (extracted from R2 key) |

The display name of the skill. If omitted or empty, the skill name is inferred from the parent directory in the R2 path.

### `description`

| Property | Value |
|---|---|
| Type | `string` |
| Required | No |
| Default | First non-heading, non-empty paragraph of the body (truncated to 200 characters) |

A short description of what the skill does. Displayed in the system prompt's skill listing to help the agent decide whether to load the skill.

### `homepage`

| Property | Value |
|---|---|
| Type | `string` |
| Required | No |
| Default | None |

URL for the skill's homepage or documentation.

### `always`

| Property | Value |
|---|---|
| Type | `boolean` |
| Required | No |
| Default | `false` |

When `true`, the skill bypasses all runtime requirement checks and is always eligible. The skill still must not be disabled via `skills.entries` config.

### `metadata`

| Property | Value |
|---|---|
| Type | JSON object (as a string or inline YAML block) |
| Required | No |
| Default | `{}` |

A JSON object containing platform-specific metadata under namespaced keys. The parser accepts relaxed JSON (trailing commas are tolerated). Three namespace keys are recognized:

| Namespace Key | Description |
|---|---|
| `gsv` | GSV platform metadata |
| `openclaw` | OpenClaw platform metadata |
| `clawdbot` | Clawdbot platform metadata |

The system resolves metadata in priority order: `gsv` > `openclaw` > `clawdbot`. The first non-undefined namespace is used for requirement evaluation.

Each namespace contains a `CustomMetadata` object with the following optional fields:

#### `emoji`

| Property | Value |
|---|---|
| Type | `string` |
| Required | No |

Display emoji for the skill.

#### `requires`

An object specifying runtime requirements.

| Field | Type | Semantics | Description |
|---|---|---|---|
| `capabilities` | `string[]` | All required | Capability IDs the host must expose (actively enforced by prompt eligibility) |

Valid capability IDs:

| Capability ID | Description |
|---|---|
| `filesystem.list` | List files in directories |
| `filesystem.read` | Read file contents |
| `filesystem.write` | Write file contents |
| `filesystem.edit` | Edit files in place |
| `text.search` | Search file contents |
| `shell.exec` | Execute shell commands |

#### `install`

| Property | Value |
|---|---|
| Type | `Array<InstallEntry>` |
| Required | No |

Installation instructions for required binaries. Each entry has:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | No | Identifier for the install method |
| `kind` | `string` | Yes | Package manager. One of: `brew`, `apt`, `node`, `go`, `uv`, `download` |
| `label` | `string` | No | Human-readable label |
| `bins` | `string[]` | No | Binaries provided by this install |
| `formula` | `string` | No | Package name for `brew` |
| `package` | `string` | No | Package name for `apt`, `node`, `go`, `uv` |

## Eligibility Evaluation

Skill eligibility is computed per prompt build through a multi-stage pipeline.

### Stage 1: Config Filter

The `skills.entries` config map is consulted. An entry is matched by (in order):

1. Skill `name`
2. Directory name extracted from the R2 location
3. Full R2 location path

If a matching entry has `enabled: false`, the skill is excluded. Config entries can also override `always` and `requires` fields from the frontmatter.

### Stage 2: Requirement Validation

Requirements are resolved from the config entry override (if present) or the skill's metadata. If the `capabilities` array contains non-string entries, empty strings, or unrecognized capability IDs, the skill is marked as having invalid requirements and is excluded — unless `always` is `true`.

### Stage 3: Runtime Evaluation

For skills that are not `always: true` and have runtime requirements, the system evaluates against connected runtime nodes:

1. **No requirements defined**: Skill is eligible.
2. **No connected hosts**: Skill is ineligible.
3. **Host filtering**: the candidate host set is narrowed by `capabilities` (host must expose all listed capability IDs).

If the candidate host set is non-empty after capability filtering, the skill is eligible.

### Stage 4: Prompt Inclusion

Eligible skills are listed in an `<available_skills>` XML block in the system prompt. Each skill entry includes:

| Field | Source | Description |
|---|---|---|
| `name` | Frontmatter or directory name | Skill display name |
| `always` | Effective policy | Shown as attribute when `true` |
| `description` | Frontmatter or extracted from body | Short description |
| `location` | R2 key | Full storage path |
| `read_path` | Computed | Virtual path for the workspace read tool |

The `read_path` maps agent-local skills from `agents/{agentId}/skills/{name}/SKILL.md` to `skills/{name}/SKILL.md`, preserving the virtual namespace. Global skills keep their `skills/` prefix as-is.

## Examples

### Minimal Skill (No Requirements)

```markdown
---
name: e2e-proof
description: Return a deterministic proof token when the user asks for "E2E SKILL PROOF"
always: false
---

# E2E Proof

Use this skill only when the user message includes the exact phrase:
`E2E SKILL PROOF`
```

### Skill with Capability Requirements

```markdown
---
name: github
description: "Interact with GitHub using the `gh` CLI."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "capabilities": ["shell.exec"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# GitHub Skill
...
```

### Skill with Capability Requirements (Node Must Support Search)

```markdown
---
name: coding-agent
description: Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background shell sessions.
metadata:
  {
    "openclaw": { "emoji": "🧩", "requires": { "capabilities": ["text.search"] } },
  }
---

# Coding Agent
...
```

### Skill with Capability Requirements

```markdown
---
name: tmux
description: Use tmux for interactive TUI applications.
metadata:
  { "gsv": { "emoji": "🖥️", "requires": { "capabilities": ["shell.exec"] } } }
---

# tmux Skill
...
```
