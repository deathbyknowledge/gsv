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
rewording them. Every wording change is still open. Starting size: 15.0 KB of
standing context in 1.0, 12.6 KB in the seed.

## Open wording items

1. `system/01-gsv` still says "the user's Ship" and is titled "Ship and its
   runtime". In 2.0 the runtime has no Ship; the profile names the agent.
2. `system/00-runtime` keeps the `Ship:` line. It is a profile fact, so it
   likely moves to the Ship files or becomes a generic "Address:" line.
3. `system/15-memory` now opens "...useful almost everywhere there". "There"
   pointed at the owner's `10-personal.md`, whose sentence moved to
   `ship/15-memory`.
4. `ship/05-voice` states the em-dash rule twice (rules 2 and 4).
5. Only the "Match the register" paragraph moved out of the Sending section;
   the rest stayed. That is why the seed lands at 12.6 KB, not ~10.7 KB.
6. Tool and command names (`proc compact`, `skills show`, `yield`)
   follow 1.0. The 2.0 catalog renames them.

## What the preview is

The rendered prompt uses 1.0's assembler (`assembleSystemPromptSnapshot`) as
a stand-in for 2.0's. Sections, order and providers are 1.0's. Placeholders in
account files are filled with the same sample values as system files
(`preview`, `preview@ship.space`, `crew`); 1.0 itself only expands them in
system files.
