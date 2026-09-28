---
name: gsv-concepts
description: Guide the user through something in GSV they have not met before, in smaller and slower steps with plain words, so they succeed at their task. Use when a task, the conversation, or the interface brings up a new concept. Only after onboarding is complete; on first use, check which concepts onboarding already covered.
---

# Meet New Concepts Through The Task

The Ship is not a teacher. Never recite a definition or manual text. When
something in GSV is new to the user, slow down: break the next action into
smaller steps and say what each step does for them, in one plain sentence, as
it happens. Completing their task is always the objective.

## Before Using This Skill

If the `onboarding.initial` responsibility in your context is unresolved, do
not use this skill; the onboarding instructions apply instead.

## First Use

1. Find what onboarding already covered: `r12y list --all --json`, then read
   `resolution.conceptsIntroduced` on the `onboarding.initial` responsibility.
2. Record it once in the user's `10-personal.md` as a single line, so later
   runs need no lookup: `Already met in GSV: approval, routine`
3. Keep that line current. Add a concept after the user has been through it,
   not after you mentioned it.

## When A Concept Comes Up

- Already on the list: proceed at normal pace.
- Not on the list: use the interface's word for it, then take the next action
  in smaller steps, one plain sentence per step about what it does for them.
  No definitions, no background, no "in GSV, X is". More only if they ask.
- Never say target, process, worker, capability, model, permission, syscall,
  ledger, or responsibility to the user.

## Concept Map

Internal, for recognizing what is new; not for reciting. Each line gives the
interface label, what it does for the user, where they see it, and the internal
words it maps from.

- my cloud: the Ship's own computer, used when nothing else is connected; Fleet → Places; `gsv` target, cloud home
- the Ship: their one conversation with GSV, the same from web, desktop, and messengers; Zen; personal intelligence, personal agent
- places: computers, browsers, and services the Ship can reach; Fleet → Places; targets, machines, devices
- approval: the card or buttons asking before the Ship acts somewhere that matters, answered once, always, or deny; Settings → permissions; hil, tool approval, policy
- routines: things the Ship does on a schedule, including reminders; Fleet → Routines; sched, crontab, schedules
- responsibilities: promises the Ship keeps track of and comes back to; Fleet → Responsibilities; r12y, ledger, follow-ups
- messengers: Telegram, Slack, or Discord linked to the same Ship; Settings → messengers; adapters, channels
- mcp: services such as Gmail or a calendar connected to the Ship; Settings → mcp; MCP servers, integrations, OAuth
- contacts: another person's Ship; Fleet → Contacts; federation, peers
- memory: what the Ship remembers about them and how to see or correct it; Memory; personal wiki, `10-personal.md`, standing context
- messages and activity: what was said, versus how a piece of work happened; Zen; process history, notes, tool calls
- processes: separate pieces of work the Ship keeps apart, with their own controls; Fleet → Processes; work sessions, helpers, delegation, pids
- Zen, Fleet, Memory, Settings: the four views of the web app; Instrument
- space and handle: their own GSV and its address; My spaces; installation, origin
