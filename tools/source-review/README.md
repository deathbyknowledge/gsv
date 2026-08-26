# GSV source review

These localhost-only developer tools review and edit repository source files directly. They are not part of the GSV product and do not require a running Gateway.

From the GSV repository root:

```bash
npm run review:prompts
npm run review:manual
```

Both commands listen on `http://127.0.0.1:4178`. Set `GSV_REVIEW_PORT` to use another port.

The prompt view evaluates the exported strings in `gateway/src/prompts/`, groups them by role, and shows their source path and approximate size. It is a source catalog, not an exact live Process prompt: runtime identity, installed skills, targets, and user-edited `context.d` files are not included.

The manual view reads the sibling `../gsv-manual` worktree by default. Set `GSV_MANUAL_ROOT` when the manual lives elsewhere:

```bash
GSV_MANUAL_ROOT=/path/to/gsv-manual npm run review:manual
```

Saving writes the selected raw source file and displays its normal Git diff. Concurrent disk edits are detected and rejected instead of overwritten. Run the focused tests with `npm run review:test`.
