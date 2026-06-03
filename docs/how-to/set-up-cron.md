# How to Configure Scheduled Work

GSV has two scheduling surfaces:

- Cron files and `crontab` for user/process-owned work.
- Package daemon schedules for package-owned backend RPC methods.

Use cron files when scheduled work should run a command, including commands
that create or notify a process.
Use package daemon schedules when a package backend needs to call one of its
own RPC methods.

Cron is an execution contract, not a separate natural-language interface. Use
your personal agent to author or revise recurring intent, then run scheduled
work through a stable shell command, timezone, and audit history.

## Add a User Crontab

User crontabs use the standard five-field cron format:

From a GSV shell:

```bash
proc agents
cat > ~/daily.cron <<'EOF'
CRON_TZ=Europe/Amsterdam
0 9 * * * proc spawn --as friday --non-interactive --label "daily ops check" "Check system health and summarize anything that needs attention."
EOF
crontab ~/daily.cron
```

Replace `friday` with the agent account username listed by `proc agents`.

The same file can be written directly:

```bash
cat > /var/spool/cron/sam <<'EOF'
CRON_TZ=Europe/Amsterdam
0 9 * * * proc spawn --as friday --non-interactive --label "daily ops check" "Check system health and summarize anything that needs attention."
EOF
```

Manage the current user's crontab:

```bash
crontab -l
crontab ~/daily.cron
crontab -r
```

Cron lines use:

```cron
minute hour day-of-month month day-of-week
```

The timezone must be an IANA timezone. If the system was initialized through
onboarding, the selected system timezone is available as
`config/server/timezone`.

## Notify an Existing Process

Use `proc send` when the schedule should wake an existing process conversation
instead of spawning a new process.

From a GSV shell:

```bash
cat > ~/pulse.cron <<'EOF'
*/15 * * * * proc send init:1000 --conversation ops "Run the scheduled ops pulse."
EOF
crontab ~/pulse.cron
```

Inside a process shell, `$GSV_PID` and `proc self` both identify the current
process.

The target process receives normal process mail.

## Add a System Cron File

Root can install `/etc/cron.d/<name>` files. These use the system crontab
format, with a user field between the five time fields and the command:

```cron
CRON_TZ=Europe/Amsterdam
0 4 * * * root proc compact init:0 --conversation default --keep-last 80 --generate-summary
30 8 * * 1-5 sam proc spawn --as friday --non-interactive --label "morning brief" "Prepare morning brief."
```

## Manage Kernel Schedules

`sched` remains the low-level schedule inspector and control surface:

```ts
await kernel.request("sched.list", { includeDisabled: true });
await kernel.request("sched.update", {
  id: "schedule-id",
  patch: { enabled: false },
});
await kernel.request("sched.remove", { id: "schedule-id" });
```

To run a schedule manually:

```ts
await kernel.request("sched.run", { id: "schedule-id", mode: "force" });
```

To sweep currently due schedules:

```ts
await kernel.request("sched.run", { mode: "due" });
```

## Add a Package Daemon Schedule

Package backends can schedule their own RPC methods through `this.daemon`.
Schedules live in the package AppRunner Durable Object, not in the Kernel
scheduler table.

```ts
import { PackageBackendEntrypoint } from "@gsv/package/backend";

export default class ReportsBackend extends PackageBackendEntrypoint {
  async enableDailyReport() {
    if (!this.daemon) {
      throw new Error("daemon scheduling is unavailable");
    }

    return this.daemon.upsertRpcSchedule({
      key: "daily-report",
      rpcMethod: "runDailyReport",
      schedule: { kind: "every", everyMs: 24 * 60 * 60 * 1000 },
      payload: { channel: "ops" },
      enabled: true,
    });
  }

  async runDailyReport(payload: { channel?: string }) {
    const files = await this.kernel.request("fs.search", {
      path: "/home/root/projects",
      query: "TODO",
    });
    await this.storage?.sql.exec(
      "INSERT INTO report_runs(created_at, payload_json) VALUES (?, ?)",
      Date.now(),
      JSON.stringify({ payload, files }),
    );
    return { ok: true };
  }
}
```
