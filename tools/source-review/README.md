# GSV source review

These localhost-only developer tools review and edit repository source files directly. They are not part of the GSV product and do not require a running Gateway.

From the GSV repository root:

```bash
npm run review:prompts
npm run review:manual
```

Both commands listen on `http://127.0.0.1:4178`. Set `GSV_REVIEW_PORT` to use another port.

The prompt workspace is for editing the repository's shipped instructions. Select
an entry under its scope and edit it beside the **Entry** preview. Each source
shows its scope: shared, Ship, Crew, owner, or standalone task.
Choose **Sections** or **Exact text** and pick **Ship** or **Crew** to inspect the
assembled standing prompt. **Sections** links each saved context file to its Markdown source; **All sources** also includes standalone task prompts.
Typing updates the preview before saving. **Save** (or Ctrl/Cmd+S) writes the file;
**Refresh** reloads changes made in another editor.

The preview calls the production prompt assembler and its providers. It supplies
sample accounts (`alex`, `ship`, `crew`), a laptop target, a fixed date, and the
built-in skill index. It is a reproducible preview of repository defaults, not a
connection to a live space or its customized instructions. It makes no inference
requests.

## Prompt files

Active standing defaults live under `workers/gateway/src/prompts/`:

```text
system/context.d/*.md   shared runtime, interaction, targets, work and memory instructions
ship/context.d/*.md     Ship's role, voice and Crew account name
crew/context.d/*.md     Crew's execution role
user/context.d/*.md     the owner's standing personal facts template
tasks/*.md              standalone task instructions
onboarding/*.md         welcome responsibility briefs, never standing context
```

Each standing Markdown file is one complete `context.d` entry. Its directory
selects the scope; its filename supplies the stored name and lexical order.
`context.ts` bundles the complete files in one catalogue shared by the system
defaults and preview. Register a new standing source there; the preview derives
its scope and source link from the path. There is no fragment concatenation or
separate source-to-entry map. Standalone tasks retain their owning callers.

Memory instructions live once in system context. Personal facts remain in the
owner's `context.d/10-personal.md` and detailed memory in their `personal` wiki.
Ship has a public voice; Crew's role defines its report without imposing a voice.

Write each rule in its owning entry. Keep shared mechanics in system context
and procedural recipes in skills/manuals. Write from the agent's perspective:
assume familiar Unix concepts and explain GSV's differences when they affect a
decision or action. Leave architecture details in documentation and tool syntax
in schemas or manuals. For Ship, acknowledgment precedes detailed planning and
responsibility work; bookkeeping precedes execution or delegation.

TypeScript imports this text during the build. Keep `{{...}}` placeholders intact:
system placeholders are expanded by the existing runtime provider;
`{{crew.username}}` is filled when the delegation file is seeded. Retired migration
matching strings/hashes and structured event formatters remain in TypeScript.

Saving here only changes the worktree. Deployment and changes to an existing
space are separate actions. System defaults remain live where no explicit
config override exists. Account defaults seed missing files. Home scaffolding
also upgrades recognized, untouched Ship role seeds and retires generated local
memory instructions now provided by system context. Customized and concurrent
edits survive. Existing specialist homes receive that cleanup when scaffolded;
the source editor never rewrites a live account's files.

When splitting `01-gsv.md`, the schema migration preserves existing explicit
overrides by leaving `02-interaction.md` empty for those installations unless
it already has its own override. Removing that empty override opts into the new
shared interaction default.

The manual view reads the sibling `../gsv-manual` worktree by default. Set `GSV_MANUAL_ROOT` when the manual lives elsewhere:

```bash
GSV_MANUAL_ROOT=/path/to/gsv-manual npm run review:manual
```

Saving writes the selected raw source file and displays its normal Git diff. Concurrent disk edits are detected and rejected instead of overwritten. Run the focused tests with `npm run review:test`.
