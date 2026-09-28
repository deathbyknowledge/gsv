# GSV source review

These localhost-only developer tools review and edit repository source files directly. They are not part of the GSV product and do not require a running Gateway.

From the GSV repository root:

```bash
npm run review:prompts
npm run review:manual
```

Both commands listen on `http://127.0.0.1:4178`. Set `GSV_REVIEW_PORT` to use another port.

The prompt workspace is for editing the repository's shipped instructions. Select
a source under a category and edit it beside the **Category** preview. Each source
shows its scope: shared, Ship, Crew, generic agent, owner, or standalone task.
Choose **Sections** or **Exact text** and pick **Ship** or **Crew** to inspect the
assembled standing prompt. **Sections** links to every source that contributes to a
saved context file; **All sources** also includes standalone task prompts.
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

| Category directory | What it teaches |
| --- | --- |
| `world-model/` | What GSV is and how its environments relate |
| `interaction/` | Incoming events, message delivery, and Ship's communication obligations |
| `computer-and-discovery/` | Targets, files, commands, manuals, skills, and integrations |
| `durable-work/` | Context snapshots and updates, responsibilities, delegation, scheduling, and follow-through |
| `knowledge/` | Shared memory, retrieval, and what to preserve |
| `role-and-judgment/` | Ship and Crew's responsibilities and execution decisions |
| `voice/` | Ship's public voice and the generic agent writing defaults |
| `instance-facts/` | Runtime values, responsibility snapshot, Crew account name, and owner context template |
| `tasks/` | Separate compaction, setup, delegated-run, and correction instructions |

Category and scope are independent. For example, `knowledge/ship.md` contributes
to Ship's saved role file, while `knowledge/agent.md` supplies an ordinary agent's
memory file. `voice/agent.md` is a default for agent accounts, not another account
named `agent`. Ship has its own voice source.

The category files contain the model-facing explanations, not just an outline:
`world-model/gsv.md` defines owners, accounts, processes, runs, conversations, and
targets; `interaction/` explains input provenance and delivery contracts;
`durable-work/continuity.md` explains initial snapshots and subsequent updates.
Computer/discovery guidance covers target selection, capabilities, and approvals.

Stored `context.d` paths and section order remain stable. Some stored files are
composed from several source categories. The TypeScript wrappers in `prompts/`
own that composition; `prompt-sources.ts` maps it for the editor. Editing a
category's wording changes its rendered contribution without changing its scope.

TypeScript imports this text during the build. Keep `{{...}}` placeholders intact:
system placeholders are expanded by the existing runtime provider;
`{{crew.username}}` is filled when the delegation file is seeded. Retired migration
matching strings and structured event formatters remain in TypeScript and are not
part of this prose editor.

Changing a shipped account default does not rewrite copies already saved in an
account's home. System defaults remain live where no explicit config override
exists. Saving here only changes the worktree; deployment and changes to an
existing space are separate actions.

When adding a prompt, wire it into its owning runtime path and the source
map in `prompt-sources.ts`. The editor uses that map to connect assembled sections
to their editable files; it does not choose runtime prompt order or policy.

The manual view reads the sibling `../gsv-manual` worktree by default. Set `GSV_MANUAL_ROOT` when the manual lives elsewhere:

```bash
GSV_MANUAL_ROOT=/path/to/gsv-manual npm run review:manual
```

Saving writes the selected raw source file and displays its normal Git diff. Concurrent disk edits are detected and rejected instead of overwritten. Run the focused tests with `npm run review:test`.
