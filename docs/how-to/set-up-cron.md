# How to Set Up Cron Jobs

The cron system lets you schedule recurring or one-shot tasks that the agent executes automatically. Jobs are stored in SQLite inside the Gateway Durable Object and checked on each alarm cycle.

## Schedule types

### One-shot (`at`)

Runs once at a specific time, then disables itself.

```json
{ "kind": "at", "atMs": 1700000000000 }
```

The tool input normalizer also accepts human-readable formats:

```json
{ "kind": "at", "at": "2025-03-15T09:00" }
{ "kind": "at", "at": "tomorrow 9am" }
{ "kind": "at", "in": "in 2 hours" }
{ "kind": "at", "inMinutes": 30 }
```

### Interval (`every`)

Runs repeatedly at a fixed interval.

```json
{ "kind": "every", "everyMs": 3600000 }
```

Convenience fields work too:

```json
{ "kind": "every", "everyMinutes": 30 }
{ "kind": "every", "everyHours": 2 }
```

You can anchor the interval to a specific start time:

```json
{ "kind": "every", "everyHours": 1, "anchorAt": "2025-03-15T09:00" }
```

### Cron expression (`cron`)

Standard 5-field cron syntax (minute, hour, day-of-month, month, day-of-week). Optionally specify a timezone.

```json
{ "kind": "cron", "expr": "0 9 * * 1-5", "tz": "America/New_York" }
```

If no timezone is specified, the gateway's configured `userTimezone` is used.

## Job modes

### systemEvent

Injects a text message into the agent's main session as if a user sent it. The agent processes it in the context of the existing conversation and responds to the last active channel.

Good for: simple reminders, periodic prompts, anything that benefits from conversation context.

```json
{
  "mode": "systemEvent",
  "text": "Check if there are any urgent emails."
}
```

### task

Runs a full agent turn in an isolated session (`agent:{agentId}:cron:{jobId}`). Each run gets a clean conversation with no carry-over from the main chat.

Good for: scheduled reports, data collection, automated workflows, anything that shouldn't pollute the main conversation.

```json
{
  "mode": "task",
  "message": "Generate a daily summary of open GitHub issues and send it.",
  "deliver": true,
  "channel": "discord",
  "to": "general"
}
```

Task mode supports additional options:

| Field | Description |
|---|---|
| `message` | The prompt for the agent (required) |
| `model` | Override the model for this job (e.g., `"claude-sonnet-4-20250514"`) |
| `thinking` | Thinking level override |
| `timeoutSeconds` | Max execution time |
| `deliver` | Whether to deliver the response to a channel (`true`/`false`) |
| `channel` | Target channel for delivery (e.g., `"discord"`, `"whatsapp"`) |
| `to` | Target peer/room for delivery |
| `bestEffortDeliver` | Don't fail the job if delivery fails |

## Create a cron job

The agent can create cron jobs using the native `gsv__CronAdd` tool during conversation. You can also create them via RPC.

Example: ask the agent to set a reminder:

> "Remind me every weekday at 9am to check my calendar."

The agent will create a job like:

```json
{
  "name": "weekday-calendar-reminder",
  "schedule": { "kind": "cron", "expr": "0 9 * * 1-5" },
  "spec": {
    "mode": "systemEvent",
    "text": "It's 9am on a weekday. Check the calendar for today's events and let the user know."
  }
}
```

Example: a one-shot delayed task:

> "In 2 hours, check if the deployment succeeded and message me on Discord."

```json
{
  "name": "check-deployment",
  "deleteAfterRun": true,
  "schedule": { "kind": "at", "in": "in 2 hours" },
  "spec": {
    "mode": "task",
    "message": "Check if the latest deployment succeeded. Report the status.",
    "deliver": true,
    "channel": "discord"
  }
}
```

## List cron jobs

```bash
gsv tools call gsv__CronList '{}'
```

Or via the RPC method `cron.list`.

## Inspect and delete cron jobs

View a specific job's run history via `cron.runs`:

```json
{ "jobId": "abc-123" }
```

Remove a job:

```json
{ "id": "abc-123" }
```

## Enable or disable the cron scheduler

```bash
gsv config set cron.enabled true
gsv config set cron.maxJobs 200
gsv config set cron.maxConcurrentRuns 4
```

When `cron.enabled` is `false`, no jobs fire on schedule (but can still be force-run).

## Common patterns

**Daily standup prompt (weekdays at 9am):**

```json
{
  "name": "daily-standup",
  "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "America/Chicago" },
  "spec": { "mode": "systemEvent", "text": "Good morning. What's on the calendar today?" }
}
```

**Hourly health check (isolated, no conversation pollution):**

```json
{
  "name": "health-check",
  "schedule": { "kind": "every", "everyHours": 1 },
  "spec": {
    "mode": "task",
    "message": "Run a health check on the production server. Only alert if something is wrong.",
    "deliver": true,
    "channel": "discord",
    "bestEffortDeliver": true
  }
}
```

**One-shot reminder (self-deleting):**

```json
{
  "name": "meeting-reminder",
  "deleteAfterRun": true,
  "schedule": { "kind": "at", "at": "today 2:30pm" },
  "spec": { "mode": "systemEvent", "text": "You have a meeting in 30 minutes." }
}
```
