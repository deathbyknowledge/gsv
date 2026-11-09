---
name: journal
description: Keep the owner's hourly journal. Use when the Journal routine wakes you for a check-in, when the owner asks to turn the journal on or off, or when they ask what happened or what you noticed during a day.
---

# Journal

The journal is the owner's record of each day. It lives in the `personal` wiki at
`pages/journal/YYYY/MM/YYYY-MM-DD.md`, in the owner's time zone. `wiki info personal`
gives its path. The Journal routine wakes you every hour while the owner is usually
awake. Each wake is a check-in: write down what happened, then decide whether the
owner would want anything done now.

## At Each Check-in

1. Look at what happened since the previous check-in: messages, mail, finished or
   failed work, events, and the responsibilities in your context. Today's page shows
   the previous entry.
2. Ask: what would the owner want me to do now? Usually the answer is nothing. Act
   when they clearly would want it, such as a follow-up that is due, a deadline today
   or something that went wrong. Message them only when it is worth an interruption;
   otherwise keep it for the next time they talk to you. Never message just to say
   you checked in.
3. Append one entry to today's page, creating it with a `# YYYY-MM-DD` title if it
   is missing. Leave the page's other entries as they are.
4. Resolve the routine's responsibility, then yield. Yield silently unless you sent
   something.

A quiet hour should take one Shell call: append the entry and resolve.

## Entry Format

`gsv journal` draws the day from these entries, so keep this shape exactly:

```markdown
## 10:00 ●
Reminded you about the dentist at 15:00.

- 09:42 ✉ Ana asked about Saturday
- 09:55 ✓ Flight search finished
```

- The heading is `## HH:MM`, the check-in's local time, then `●` if you did
  something or `·` if the hour was quiet.
- One line says what you did. For a quiet hour, say what you noticed and why you
  left it. Write to the owner ("you"), in their language.
- One bullet per event since the previous check-in, with its local time and a mark:
  `✉` a message or mail, `✓` work finished, `⚑` something that needs the owner,
  `✗` something that failed, `◆` anything else. A quiet hour with no events has no
  bullets.
- Summarize; don't copy private content the owner wouldn't want to read back.

## Turn It On or Off

When the owner asks for the journal:

```bash
sched add --ship --name Journal --cron "0 7-23 * * *" --message "Journal check-in. Use the journal skill."
```

Change the hours in the cron line when the owner keeps different hours. To stop it,
find the Journal routine with `sched list` and `sched remove ID`. From a terminal,
the owner can run `gsv journal on`, `gsv journal off`, and `gsv journal` to see a day.
