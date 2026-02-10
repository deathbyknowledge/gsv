# Skills Config (`skills.entries`)

Use `skills.entries` to control skill eligibility without editing `SKILL.md`.

## What It Controls

- `enabled`: hard enable/disable for a skill.
- `always`: override the skill's `always` frontmatter.
- `requires`: override runtime capability requirements used for skill visibility.

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
          "anyCapabilities": ["text.search"]
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
    "capabilities": ["shell.exec"]
  }
}'
```

Mark a skill always-eligible:

```bash
gsv config set skills.entries.memory-update '{"always":true}'
```

## Runtime Requirement Values

Current host roles:

- `execution`
- `specialized`

Current capabilities:

- `filesystem.list`
- `filesystem.read`
- `filesystem.write`
- `filesystem.edit`
- `text.search`
- `shell.exec`

## Notes

- `skills.entries` is policy, not storage: skills still come from R2 (`agents/<id>/skills/*` and `skills/*`).
- Agent-local skills override global skills with the same name.
- Skill visibility is computed per run from:
  1. skill frontmatter
  2. `skills.entries` overrides
  3. connected runtime node capabilities
