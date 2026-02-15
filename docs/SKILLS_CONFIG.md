# Skills Config (`skills.entries`)

Use `skills.entries` to control skill eligibility without editing `SKILL.md`.

## What It Controls

- `enabled`: hard enable/disable for a skill.
- `always`: override the skill's `always` frontmatter.
- `requires`: override runtime requirements used for skill visibility.

## Config Shape

```json
{
  "skills": {
    "entries": {
      "<skill-key>": {
        "enabled": true,
        "always": false,
        "requires": {
          "hostRoles": ["execution"],
          "capabilities": ["shell.exec"],
          "anyCapabilities": ["text.search"],
          "bins": ["gh"],
          "anyBins": ["codex", "claude"],
          "env": ["GITHUB_TOKEN"],
          "config": ["apiKeys.openai"],
          "os": ["darwin"]
        }
      }
    }
  }
}
```

`<skill-key>` can be:

- the skill name (`gsv-cli`)
- the location-derived key (`gsv-cli` from `skills/gsv-cli/SKILL.md`)
- the full location (`skills/gsv-cli/SKILL.md`)

## CLI Examples

`gsv config set` parses JSON values when possible.

Disable a skill:

```bash
gsv config set skills.entries.gsv-cli '{"enabled":false}'
```

Enable it again:

```bash
gsv config set skills.entries.gsv-cli '{"enabled":true}'
```

Override runtime requirements:

```bash
gsv config set skills.entries.gsv-cli '{
  "enabled": true,
  "requires": {
    "hostRoles": ["execution"],
    "capabilities": ["shell.exec"],
    "bins": ["gh"],
    "env": ["GITHUB_TOKEN"]
  }
}'
```

Mark a skill always-eligible:

```bash
gsv config set skills.entries.coding-agent '{"always":true}'
```

## Runtime Requirement Values

Host roles:

- `execution`
- `specialized`

Capabilities:

- `filesystem.list`
- `filesystem.read`
- `filesystem.write`
- `filesystem.edit`
- `text.search`
- `shell.exec`

Additional requirement keys:

- `bins` / `anyBins` (binary presence on node, cached via `skills.update`)
- `env` (environment variable names present on node)
- `config` (dotted gateway config paths with non-empty values)
- `os` (node OS identifiers like `darwin`, `linux`, `windows`)

## Notes

- `skills.entries` is policy, not storage: skills still come from R2 (`agents/<id>/skills/*` and `skills/*`).
- Agent-local skills override global skills with the same name.
- Skill visibility is computed per run from:
  1. skill frontmatter
  2. `skills.entries` overrides
  3. connected runtime node facts (roles/capabilities/os/env/bin cache) and config paths
