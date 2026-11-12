# 2.0 standing context draft

This folder is a working copy of 1.0's standing context, laid out like
`workers/gateway/src/prompts/`. Edit it with `npm run review:context`. Nothing
here ships; 1.0's prompt files stay untouched.

## Layout

```text
system/context.d/   runtime instructions every agent sees
ship/context.d/     the Ship profile's agent (1.0's Ship account)
crew/context.d/     the Ship profile's worker agent
user/context.d/     owner files, if any survive (none seeded: 2.0 copies nothing into homes)
moved/skills/       text leaving standing context for a skill; each file names its destination
moved/dropped.md    text leaving with no new home, and why
```

Only `<scope>/context.d/*.md` enters the rendered prompt. This file and
`moved/` never do.

## How the seed was made

The seed moves whole paragraphs and sentences out of 1.0's files without
rewording them. Starting size: 15.0 KB of
standing context in 1.0, 12.6 KB in the seed, 12.4 KB after the wording
changes below.

## Wording decided 2026-11-12

1. Runtime files say nothing about Ship: `system/01-gsv` is "# Runtime",
   "You are an agent running on GSV...".
2. The Ship's address moved from `system/00-runtime` to the top of
   `ship/01-ship`. The email line stays in the runtime (one mailbox per
   person owner).
3. `system/15-memory`: "keep only concise, explicit facts and preferences
   useful almost everywhere."
4. `ship/05-voice` states the em-dash rule once (rule 4).
5. The Sending section stays standing context; only its closing sentence,
   which repeated the section, went.

## Open

- Tool and command names (`proc compact`, `skills show`, `yield`) follow
  1.0. They change with the 2.0 catalog write-up.
- The keep/move list, row by row.

## What the preview is

The rendered prompt uses 1.0's assembler (`assembleSystemPromptSnapshot`) as
a stand-in for 2.0's. Sections, order and providers are 1.0's. Placeholders in
account files are filled with the same sample values as system files
(`preview`, `preview@ship.space`, `crew`); 1.0 itself only expands them in
system files.
