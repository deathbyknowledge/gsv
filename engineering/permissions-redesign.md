# Permissions: one rule list per person

Status: implemented on `feat/one-approval-policy`, 2026-10-23.

## Problem

**Always allow** saved a rule in the private storage of the process that asked.
Nothing else read it. Crew children, Work processes and a replacement Ship pid
asked again, so people saw the same prompt over and over. On top of that, four
other mechanisms decided approvals:

```text
before
  default rules ─────────┐
  account policy ────────┼─ first found: run-as account, then owner ─┐
  mail guard (code) ─────┘                                           ├─▶ decision
  defaultAction "ask" in code (sched.add, sched.update, approach.create)
  per-process Always allow rules ────────────────────────────────────┘
```

The surfaces disagreed too. The card offered Always allow only for shell
commands. Messengers offered it everywhere and replied "Allowed for this
conversation", which was not true.

## Model

```text
after
  owner's policy   users/<owner>/ai/tools/approval
                   (config/ai/tools/approval until they have one)
       ▲  Settings → Permissions edits it
       ▲  Always allow adds { match: syscall, target, action: "auto" }
       │
       └── Ship, Crew, any child: one list; most specific rule wins
```

- **One list per human owner.** The Kernel derives the owner from the process
  registry and sends that list as the run's policy. An agent account's own key
  is no longer read.
- **Everything is a rule.** Mail, MCP calls, scheduled commands and first-contact
  message requests ask because the default rules say so. The mail guard and the
  `defaultAction` parameter are gone.
- **Always allow edits the list.** The Process asks the Kernel to put
  `{ match: syscall, target, action: "auto" }` first in the owner's list. When
  the owner has no list, the installation default is copied first. The Kernel
  refuses a broad target (`targets/*`, `*`) or an unreadable stored list, and
  `proc.hil` then reports `remembered: false`.
- **Fresh before asking.** A run takes the policy when it starts. Before it
  prompts, it reads the owner's current policy from the Kernel, so an allow made
  on another process applies straight away. If that read fails, the run's own
  policy stands and it asks.
- **Offered everywhere it is exact.** The card, Fleet and messengers offer Always
  allow for any request on one target. Messengers say "Allowed from now on" only
  when the rule was added, and "Allowed once" otherwise.

Unchanged: capabilities still come first and rules cannot grant access. Only a
human interaction can decide (`kernel/proc-handlers.ts`). Block never reaches
a prompt, so Always allow never overrides it.

## Migration

- **Kernel v072.** Saved policies that allowed by default and had no rule for
  `mail.send`, `sched.add`, `sched.update` or `approach.create` gain an `ask`
  rule for it. That is exactly what the removed code did, so every saved policy
  decides those calls as before. It reads rules as the runtime does, including
  a legacy `when.target` and dropping unreadable rules. Rows that are not valid
  JSON are left alone.
- **Process v018.** Deletes the old per-process `toolApprovalOverrides` key.
  Those rules only ever applied to one pid, so people click once more and the
  new rule covers every process. A run under way during the upgrade carries a
  policy copied before these rules existed; v018 replaces it with one that
  asks, so the run reads the owner's current policy before its next decision.
- **Agent account policies** stop being read. None of the UI wrote them (the
  console writer had no callers and is removed).

## Edge cases

- Settings saves with compare-and-set. If Always allow lands while someone has
  an unsaved draft, the save reports that the policy changed elsewhere, and
  discarding the draft loads the new rule.
- A child already waiting on a prompt keeps waiting. Its next request runs
  without asking.
- Schedules and message requests ask only when they need to. The Kernel checks
  them itself once it knows whether a schedule runs a command or a message
  request is new. A direct CodeMode call honours Block but leaves asking to that
  check, so a reminder never asks and a command asks once.

## Open questions

1. **Families of actions.** One allow covers one syscall. Editing and deleting
   a file still ask separately. Should Always allow on `fs.write` cover `fs.*`?
2. **Re-paired machines.** A re-paired laptop gets a new target id, so its
   allows stop matching. Accept that, or key rules by a stable device identity?
3. **Defaults freeze on first allow.** The first Always allow copies the
   installation default into the owner's list, so later changes to the
   built-in defaults no longer reach that owner. A security-relevant new
   default therefore needs a migration, as v072 does.
