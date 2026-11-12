# 13 · Ship profile

2.0 has no app layer. Ship is the release's person profile: a declarative
description of a person's agents, conversations and responsibility kinds, plus
read-only content, applied to every person owner `[D 11-12]`. The runtime holds
no Ship names; it reads only the compiled profile.

## Shape

Three root keys `[D 11-12]`:

```ts
// ship/profile.ts. Keys and their meaning [D 11-12]; exact syntax [NEW].
import { profile, ev } from "@gsv/runtime/profile";

export default profile({
  agents: {
    ship: { model: "chat" },     // long-lived handler of the personal conversation
    crew: { model: "work" },     // delegated work, `proc delegate --as crew`
  },
  conversations: {
    personal: { handler: "ship", follow: true },
    groups: { handler: "ship", per: "group" },
  },
  responsibilities: {
    onboarding: {
      to: "personal",
      from: [ev("conversation.opened", { conversation: "personal" }),
             ev("conversation.message", { conversation: "personal", author: "person" })],
      key: "onboarding",          // once per owner, forever
    },
    "memory.review": {
      to: "personal",
      from: [ev("proc.history.archived", { agent: "ship" })],
      key: "{pid}:{segment}",
      oneAtATime: true,
    },
    "mail.received": { to: "personal", from: [ev("channel.mail.received")], key: "{message}" },
    "machine.added": { to: "personal", from: [ev("machine.created")], key: "{machine}" },
    "messenger.connected": {
      to: "personal", from: [ev("channel.created", { type: "messenger" })], key: "{channel}",
    },
    "messenger.signed_out": {
      to: "personal",
      from: [ev("channel.updated", { type: "messenger", status: "signed_out" })],
    },
  },
});
```

| Key | Meaning |
| --- | --- |
| `agents.<name>` | An agent account created for every person owner. Default grants are the decided ones (everything the owner holds minus people-only). `model` names the stack purpose `[D 11-12]` `[D 11-09]` |
| `conversations.<name>` | A conversation labelled (profile, name). `handler` is the agent whose current process handles it; `follow: true` makes it the person's followed conversation; `per: "group"` makes one per messenger group `[D 11-12]` |
| `responsibilities.<kind>` | A responsibility kind. `to`: whose conversation's handler takes it. `from`: typed references into the event catalog, compiled to (family, kind); the build fails on unknown events. `key`: a template over payload fields, unique per (owner, kind, key) forever; repeatable kinds leave it out. `where`: an equality filter on payload fields, checked at build. `oneAtATime`: later ones wait in order. Each kind gets an automatic on/off setting labelled by the i18n key `responsibility.<kind>` `[D 11-12]` |

The second argument of `ev(kind, where)` is the `where` filter `[NEW]`. Values
naming profile agents or conversations are typed references resolved at
reconcile `[D 11-12]`.

The runtime keeps three rules of its own for every agent, including team agents
later: a message-started run ends with Send or an explicit silent yield;
delegation; schedules `[D 11-12]`.

## Content

By folder convention, read-only from the release, never copied into homes;
names are reserved and people add files beside them `[D 11-12]`.

```text
ship/
  profile.ts
  agents/ship/context.d/*.md      Ship's role, voice, Ship facts
  agents/crew/context.d/*.md      Crew's role
  skills/<name>/SKILL.md          Ship's skills
  manual/                         the Manual
  responsibilities/<kind>.md      each kind's brief (onboarding.md from 1.0's welcome brief)
  web/                            Ship's web UI (the `ui` assets)
runtime/content/
  context.d/*.md                  runtime standing context (no product words)
  tasks/*.md                      compaction, context-runway, delegated, yield-correction
  skills/<name>/SKILL.md          runtime skills
```

- The starting text is the 2.0 context draft (`design/context-2.0` on branch
  `tools/context-workbench`, 12,355 B of standing context), which the founder
  amends once the dev environment runs `[D 11-12]`.
- Task prompts: compaction, context-runway, delegated and yield-correction are
  runtime content; the memory-review brief and the onboarding brief are Ship's;
  operator updates become release briefs; setup-assist leaves `[D 11-12]`
  (placement proposed 11-12, kept with the draft).
- The protected-prompt rule moves with the content: `ship/**` and
  `runtime/content/**` change only with the founder's explicit go `[D 11-12]`.
- The build compiles the profile to JSON plus a content bundle and runs the
  frozen-key check `[D 11-12]`.

## Reconcile

```mermaid
sequenceDiagram
  participant E as Event (sign-in, message, any admission)
  participant O as Owner DO
  E->>O: first admission after a release
  O->>O: compiled profile hash == owner's applied hash?
  alt differs
    O->>O: create missing agents, conversations, kinds; open release briefs
    O->>O: store the new hash
  end
  O->>O: continue the admission
```

`[D 11-12]`

- Runs in the owner DO before the first admission after a profile change,
  idempotent, creating missing pieces and never deleting.
- The applied state is the hash of the compiled profile, stored on the owner;
  there is no hand-written version.
- Owners that never wake never reconcile: no fleet-wide write.

### Release changes

| Change | Effect |
| --- | --- |
| Agent removed | It stays as an ordinary agent account |
| Conversation removed | Its history stays; its handler is cleared |
| Kind added | Applies to new events only, no backfill |
| Kind removed | Open items finish |
| Key template changed | The build refuses it (frozen against the last release), else everyone would re-onboard |
| Content changed | Epochs using it close |

`[D 11-12]`

### Release briefs

Operator release briefs live in `gsv.config.ts`. Reconcile opens one runtime
responsibility per brief per person owner, sent to the followed conversation,
keyed by the brief id `[D 11-12]`.

## Onboarding

`[D 11-12]`

- The `onboarding` kind opens when the person first opens their personal
  conversation or writes to it, not at sign-in.
- It opens inside the admission of that event (the append transaction), so the
  first reply already follows the brief.
- The key makes it once per owner, forever.
- The brief (goal, acceptance criteria, steps) is content; the Ship judges the
  criteria from it.
- The welcome card and the first-run messenger screen are Ship's own UI.
- The time from a responsibility opening to the first message in its
  conversation is a generic runtime metric per kind.

## Signup templates

Every person owner gets the deployment's profile. The personal signup template
is just a plan `[D 11-12]`.

## Invariants

- **PROF-1** Reconcile is idempotent: running it twice changes nothing the second time.
- **PROF-2** Reconcile never deletes an agent, conversation, responsibility or file.
- **PROF-3** A (owner, kind, key) responsibility is created at most once, ever.
- **PROF-4** The runtime builds and passes its tests with a non-Ship test profile.
- **PROF-5** No profile content is ever written into a home.

## Tests

- Reconcile twice; reconcile after adding a kind, removing a conversation, removing an agent.
- The build refuses a changed key template and an unknown event in `from`.
- Onboarding opens in the first message's admission and never again.
- Memory review: two archived segments in a row; the second waits for the first (`oneAtATime`).
- Messenger signed out: `channel.updated` with the status opens one responsibility per occurrence.
