# GSV source review

These localhost-only developer tools review and edit repository source files directly. They are not part of the GSV product and do not require a running Gateway.

From the GSV repository root:

```bash
npm run review:prompts
npm run review:manual
```

Both commands listen on `http://127.0.0.1:4178`. Set `GSV_REVIEW_PORT` to use another port.

The prompt workspace is for editing the repository's shipped instructions. Pick
**Ship** or **Crew**, select a Markdown source, and edit it beside the assembled
preview. **Sections** shows where each piece comes from; **Exact text** shows the
assembled model input; **All sources** also includes standalone task prompts.
Typing updates the preview before saving. **Save** (or Ctrl/Cmd+S) writes the file;
**Refresh** reloads changes made in another editor.

The preview calls the production prompt assembler and its providers. It supplies
sample accounts (`alex`, `ship`, `crew`), a laptop target, a fixed date, and the
built-in skill index. It is a reproducible preview of repository defaults, not a
connection to a live space or its customized instructions. It makes no inference
requests.

## Prompt files

Active standing defaults and standalone task prompts live in
`workers/gateway/src/prompts/` as Markdown:

| Directory | Used for |
| --- | --- |
| `system/` | Shared `config/ai/context.d/` defaults, in filename order |
| `ship/` | Ship's role, voice, and delegation account |
| `crew/` | Crew's role |
| `agent/` | Shared style and memory guidance for ordinary agent accounts |
| `user/` | The human owner's shared standing context |
| `tasks/` | Compaction, setup, delegated-run delivery, and yield correction |

TypeScript imports this text during the build. Keep `{{...}}` placeholders intact:
system placeholders are expanded by the existing runtime provider;
`{{crew.username}}` is filled when the delegation file is seeded. Retired migration
matching strings and structured event formatters remain in TypeScript and are not
part of this prose editor.

Changing a shipped account default does not rewrite copies already saved in an
account's home. System defaults remain live where no explicit config override
exists. Saving here only changes the worktree; deployment and changes to an
existing space are separate actions.

When adding a prompt, wire it into its owning runtime path and the small source
map in `prompt-preview.ts`. The editor uses that map to connect assembled sections
to their editable files; it does not choose runtime prompt order or policy.

The manual view reads the sibling `../gsv-manual` worktree by default. Set `GSV_MANUAL_ROOT` when the manual lives elsewhere:

```bash
GSV_MANUAL_ROOT=/path/to/gsv-manual npm run review:manual
```

Saving writes the selected raw source file and displays its normal Git diff. Concurrent disk edits are detected and rejected instead of overwritten. Run the focused tests with `npm run review:test`.
