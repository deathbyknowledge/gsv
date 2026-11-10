---
name: check-in
description: Handle a tick of the owner's clock. Use when the Clock routine wakes you, or when the owner asks to turn the hourly check-in on or off.
---

# Check-in

The Clock routine wakes you every hour while the owner is usually awake. Messages,
mail and events still wake you when they happen; the clock makes sure you never go
more than an hour without looking.

## At Each Tick

1. Look at what happened since the previous tick: messages, mail, finished or failed
   work, events, and the responsibilities in your context.
2. Ask: what would the owner want me to do now? Usually the answer is nothing. Act
   when they clearly would want it, such as a follow-up that is due, a deadline today
   or something that went wrong. Do it the way you would do any other work.
3. Message the owner only when it is worth an interruption; otherwise keep it for
   the next time they talk to you. Never message just to say you checked in.
4. Resolve the tick's responsibility, then yield. Yield silently unless you sent
   something.

A quiet tick needs no tool call beyond resolving the responsibility.

## Turn It On or Off

When the owner asks for the hourly check-in:

```bash
sched add --ship --name Clock --cron "0 7-23 * * *" --message "Clock tick. Use the check-in skill."
```

Change the hours in the cron line when the owner keeps different hours. To stop it,
find the Clock routine with `sched list` and `sched remove ID`. From a terminal, the
owner can run `gsv clock on`, `gsv clock now`, `gsv clock off`, and `gsv clock` to
see whether it is on.
