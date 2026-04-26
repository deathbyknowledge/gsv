# How to Configure Automation

GSV has two current scheduling surfaces:

- Built-in Kernel automation for archivist and curator workers.
- Package daemon schedules for package-owned backend RPC methods.

The typed `sched.*` syscalls exist in the protocol, but the dispatcher currently
returns `501 not yet implemented`. Do not build user cron workflows on
`sched.add` yet.

## Configure Built-in Automation

Built-in automation is stored in Kernel SQLite and controlled by config keys.
Root can tune the intervals:

```bash
gsv config get config/automation
gsv config set config/automation/archivist/min_interval_ms 300000
gsv config set config/automation/curator/interval_ms 3600000
gsv config set config/automation/curator/batch_size 5
```

Set `config/automation/curator/interval_ms` to `0` to disable the periodic
curator sweep:

```bash
gsv config set config/automation/curator/interval_ms 0
```

Archivist jobs are scheduled from process activity and workspace checkpointing.
Curator jobs periodically review staged durable knowledge candidates.

## Add a Package Daemon Schedule

Package backends can schedule their own RPC methods through `this.daemon`.
Schedules live in the package AppRunner Durable Object, not in the Kernel cron
table.

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

Supported schedule shapes:

```ts
{ kind: "at", atMs: Date.now() + 60_000 }
{ kind: "after", afterMs: 60_000 }
{ kind: "every", everyMs: 3_600_000, anchorMs: Date.now() }
```

## List or Remove Package Schedules

Expose backend RPC methods for schedule management:

```ts
async listSchedules() {
  return this.daemon?.listRpcSchedules() ?? [];
}

async disableDailyReport() {
  return this.daemon?.removeRpcSchedule("daily-report") ?? { removed: false };
}
```

Call those methods from the package UI or CLI command. The schedule invokes the
named backend RPC method with the stored payload and sets
`this.daemon.trigger` while the scheduled method is running.

## Choose the Right Mechanism

- Use built-in automation for GSV's own archivist and curator behavior.
- Use package daemon schedules for app-specific recurring backend work.
- Use an external scheduler plus `gsv chat` or `gsv proc send` if you need
  operator-level cron today.
- Wait for `sched.*` implementation before documenting user-managed Kernel cron
  jobs.
