# Default Agent Context Review

This is a source-derived, standalone review surface for the exact `systemPrompt`
assembled for a new user's first Chat turn after the web setup wizard completes.

Open it from a local static server at the repository root:

```bash
python3 -m http.server 4173
```

Then visit:

```text
http://localhost:4173/engineering/default-context-review/
```

The page supports per-block edits and inclusion decisions, live prompt
recomposition, source highlighting, browser-local saves, JSON import/export,
and plain-text prompt download. Saved drafts do not write GSV config, agent home
files, or TypeScript sources.

## Refresh the source snapshot

`snapshot.js` is generated from the prompt constants and seeded skill
frontmatter in this checkout:

```bash
gateway/node_modules/.bin/tsx engineering/default-context-review/generate.ts
```

Check that a committed snapshot is current without changing it:

```bash
gateway/node_modules/.bin/tsx engineering/default-context-review/generate.ts --check
```

The serializer in `model.js` mirrors
`gateway/src/process/context/assembly.ts`: context roots are grouped first,
files remain in lexical/provider order, empty or excluded files disappear, and
the derived `available_skills` section follows the context roots.

## Scope

The review deliberately separates three model-input fields:

- `systemPrompt`: fully rendered and editable here.
- first user message: shown as adjacent input with the GSV Web Desktop origin
  and automatic-reply annotation.
- tool schemas: identified by their seven visible names, but not reproduced;
  they are supplied separately and depend on effective capabilities and online
  targets.

The default scenario uses a human account named `alex`, the first available
default personal-agent name `friday`, no connected target beyond `gsv`, no ready
MCP server, and an editable date/timezone. `00-boot.md` is included because
`sys.setup` seeds it and completion of the browser wizard does not delete it.
