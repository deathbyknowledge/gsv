# How to Configure Scheduled Work

GSV has two scheduling surfaces:

- Kernel schedules through `sched.*` for user/process-owned work.
- Package daemon schedules for package-owned backend RPC methods.

Use Kernel schedules when scheduled work should create or notify a process.
Use package daemon schedules when a package backend needs to call one of its
own RPC methods.

## Add a Kernel Schedule

Kernel schedules have an expression and a typed target.

From a GSV shell:

```bash
sched add --name "daily ops check" --cron "0 9 * * *" --timezone Europe/Amsterdam \
  --profile cron --label "daily ops check" \
  "Check system health and summarize anything that needs attention."
```

Programmatically:

```ts
await kernel.request("sched.add", {
  name: "daily ops check",
  expression: {
    kind: "cron",
    expr: "0 9 * * *",
    timezone: "Europe/Amsterdam",
  },
  target: {
    kind: "process.spawn",
    profile: "cron",
    label: "daily ops check",
    prompt: "Check system health and summarize anything that needs attention.",
  },
});
```

Supported expression shapes:

```ts
{ kind: "at", atMs: Date.now() + 60_000 }
{ kind: "after", afterMs: 60_000 }
{ kind: "every", everyMs: 3_600_000, anchorMs: Date.now() }
{ kind: "cron", expr: "0 9 * * *", timezone: "Europe/Amsterdam" }
```

Cron expressions use five Linux-style fields:

```text
minute hour day-of-month month day-of-week
```

The timezone must be an IANA timezone. If the system was initialized through
onboarding, the selected system timezone is available as
`config/server/timezone`.

## Notify an Existing Process

Use `process.event` when the schedule should wake an existing process
conversation instead of spawning a new process.

From a GSV shell:

```bash
sched add --name "ops pulse" --every 15m --pid "$GSV_PID" --conversation ops \
  --message "Run the scheduled ops pulse."
```

Inside a process shell, `$GSV_PID` and `proc self` both identify the current
process.

Programmatically:

```ts
await kernel.request("sched.add", {
  name: "ops pulse",
  expression: { kind: "every", everyMs: 15 * 60 * 1000 },
  target: {
    kind: "process.event",
    pid: "init:1000",
    conversationId: "ops",
    message: "Run the scheduled ops pulse.",
    data: { source: "cron" },
  },
});
```

The target process sees this as a runtime event. In model context it is rendered
with the normal `[Process Event]:` prefix.

## Manage Kernel Schedules

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
      path: "/workspaces",
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
