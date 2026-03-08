import { useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useReactUiStore } from "../state/store";

type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
};

type CronMode =
  | { mode: "systemEvent"; text: string }
  | {
      mode: "task";
      message: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      deliver?: boolean;
      channel?: string;
      to?: string;
    };

type CronJob = {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  spec: CronMode;
  state: CronJobState;
};

type CronRun = {
  id: number;
  jobId: string;
  ts: number;
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  durationMs?: number;
  nextRunAtMs?: number;
};

type CronStatus = {
  enabled: boolean;
  count: number;
  dueCount: number;
  runningCount: number;
  nextRunAtMs?: number;
  maxJobs: number;
  maxConcurrentRuns: number;
};

function formatSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "at") {
    return `Once at ${new Date(schedule.atMs).toLocaleString()}`;
  }
  if (schedule.kind === "every") {
    const ms = schedule.everyMs;
    if (ms >= 86_400_000) return `Every ${Math.round(ms / 86_400_000)}d`;
    if (ms >= 3_600_000) return `Every ${Math.round(ms / 3_600_000)}h`;
    if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
    return `Every ${Math.round(ms / 1_000)}s`;
  }
  return `${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (Math.abs(diff) < 60_000) return "just now";
  const future = diff < 0;
  const abs = Math.abs(diff);
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

function StatusPill({ status }: { status?: string }) {
  if (!status) {
    return null;
  }
  if (status === "ok") {
    return <Badge variant="primary">ok</Badge>;
  }
  if (status === "error") {
    return <Badge variant="destructive">error</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function CreateCronForm() {
  const cronAdd = useReactUiStore((s) => s.cronAdd);
  const setCronTab = useReactUiStore((s) => s.setCronTab);
  const loadCron = useReactUiStore((s) => s.loadCron);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"every" | "cron" | "at">("every");
  const [scheduleValue, setScheduleValue] = useState("");
  const [mode, setMode] = useState<"task" | "systemEvent">("task");
  const [message, setMessage] = useState("");
  const [deleteAfterRun, setDeleteAfterRun] = useState(false);

  return (
    <div className="card" style={{ maxWidth: 600 }}>
      <div className="card-header">
        <span className="card-title">Create Cron Job</span>
      </div>
      <div className="card-body">
        <div className="form-group">
          <Input
            label="Name"
            type="text"
            className="ui-input-fix"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="daily-report"
          />
        </div>

        <div className="form-group">
          <Input
            label="Description"
            type="text"
            className="ui-input-fix"
            size="lg"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional description"
          />
        </div>

        <div className="form-group">
          <Select<string>
            label="Schedule Type"
            hideLabel={false}
            value={scheduleKind}
            onValueChange={(value) =>
              setScheduleKind(String(value || "every") as "every" | "cron" | "at")
            }
          >
            <Select.Option value="every">Interval (every N minutes)</Select.Option>
            <Select.Option value="cron">Cron Expression</Select.Option>
            <Select.Option value="at">One-time (at specific time)</Select.Option>
          </Select>
        </div>

        <div className="form-group">
          <Input
            label="Schedule Value"
            type="text"
            className="mono ui-input-fix"
            size="lg"
            value={scheduleValue}
            onChange={(event) => setScheduleValue(event.target.value)}
            placeholder="30 (minutes) or */5 * * * * (cron) or ISO date"
          />
          <p className="form-hint">
            For "every": interval in minutes. For "cron": cron expression. For
            "at": ISO date.
          </p>
        </div>

        <div className="form-group">
          <Select<string>
            label="Mode"
            hideLabel={false}
            value={mode}
            onValueChange={(value) =>
              setMode(String(value || "task") as "task" | "systemEvent")
            }
          >
            <Select.Option value="task">Task (isolated session)</Select.Option>
            <Select.Option value="systemEvent">
              System Event (inject into main session)
            </Select.Option>
          </Select>
        </div>

        <div className="form-group">
          <Textarea
            label="Message / Text"
            className="ui-input-fix"
            size="lg"
            rows={3}
            value={message}
            onValueChange={setMessage}
            placeholder="The prompt or message for the agent"
          />
        </div>

        <div className="form-group">
          <Checkbox
            label="Delete after run (one-shot)"
            checked={deleteAfterRun}
            onCheckedChange={setDeleteAfterRun}
          />
        </div>

        <Button
          variant="primary"
          onClick={async () => {
            const trimmedName = name.trim();
            const trimmedSchedule = scheduleValue.trim();
            const trimmedMessage = message.trim();
            if (!trimmedName || !trimmedSchedule || !trimmedMessage) {
              alert("Name, schedule value, and message are required.");
              return;
            }

            let schedule: CronSchedule;
            if (scheduleKind === "every") {
              schedule = {
                kind: "every",
                everyMs: parseFloat(trimmedSchedule) * 60_000,
              };
            } else if (scheduleKind === "cron") {
              schedule = { kind: "cron", expr: trimmedSchedule };
            } else {
              schedule = {
                kind: "at",
                atMs: new Date(trimmedSchedule).getTime(),
              };
            }

            const spec: CronMode =
              mode === "task"
                ? { mode: "task", message: trimmedMessage }
                : { mode: "systemEvent", text: trimmedMessage };

            try {
              await cronAdd({
                name: trimmedName,
                description: description.trim() || undefined,
                enabled: true,
                deleteAfterRun,
                schedule,
                spec,
              });
              setCronTab("jobs");
              await loadCron();
            } catch (error) {
              alert(
                `Failed to create job: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }}
        >
          Create Job
        </Button>
      </div>
    </div>
  );
}

export function CronView() {
  const cronStatus = useReactUiStore((s) => s.cronStatus as CronStatus | null);
  const cronJobs = useReactUiStore((s) => s.cronJobs as CronJob[]);
  const cronRuns = useReactUiStore((s) => s.cronRuns as CronRun[]);
  const cronLoading = useReactUiStore((s) => s.cronLoading);
  const cronTab = useReactUiStore((s) => s.cronTab);
  const setCronTab = useReactUiStore((s) => s.setCronTab);
  const loadCron = useReactUiStore((s) => s.loadCron);
  const loadCronRuns = useReactUiStore((s) => s.loadCronRuns);
  const cronUpdate = useReactUiStore((s) => s.cronUpdate);
  const cronRemove = useReactUiStore((s) => s.cronRemove);
  const cronRun = useReactUiStore((s) => s.cronRun);

  const stats = useMemo(
    () => [
      { label: "Total Jobs", value: cronStatus?.count ?? 0 },
      { label: "Due Now", value: cronStatus?.dueCount ?? 0 },
      { label: "Running", value: cronStatus?.runningCount ?? 0 },
    ],
    [cronStatus],
  );

  return (
    <div className="view-container">
      {cronStatus ? (
        <div className="cards-grid" style={{ marginBottom: "var(--space-6)" }}>
          {stats.map((item) => (
            <div className="card" key={item.label}>
              <div className="card-body stat">
                <div className="stat-value">{item.value}</div>
                <div className="stat-label">{item.label}</div>
              </div>
            </div>
          ))}
          <div className="card">
            <div className="card-body stat">
              <div className="stat-value">
                {cronStatus.enabled ? (
                  <span style={{ color: "var(--accent-success)" }}>On</span>
                ) : (
                  <span style={{ color: "var(--accent-danger)" }}>Off</span>
                )}
              </div>
              <div className="stat-label">Cron Engine</div>
            </div>
          </div>
        </div>
      ) : null}

      <Tabs
        value={cronTab}
        onValueChange={(value) => {
          const nextTab = value as "jobs" | "runs" | "create";
          setCronTab(nextTab);
          if (nextTab === "runs") {
            void loadCronRuns();
          }
        }}
        tabs={[
          { value: "jobs", label: "Jobs" },
          { value: "runs", label: "Run History" },
          { value: "create", label: "+ New Job" },
        ]}
        className="tabs"
      />

      {cronLoading ? (
        <div className="empty-state">
          <span className="spinner"></span> Loading...
        </div>
      ) : cronTab === "jobs" ? (
        cronJobs.length ? (
          <>
            <div className="section-header">
              <span className="section-title">Jobs ({cronJobs.length})</span>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void loadCron();
                  }}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    if (confirm("Run all due cron jobs now?")) {
                      void cronRun({ mode: "due" });
                    }
                  }}
                >
                  Run Due
                </Button>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              {cronJobs.map((job) => (
                <div className="card" key={job.id}>
                  <div className="card-header">
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <span className="card-title">{job.name}</span>
                      <Badge variant={job.enabled ? "primary" : "outline"}>
                        {job.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <StatusPill status={job.state.lastStatus} />
                      {job.deleteAfterRun ? (
                        <Badge variant="outline">One-shot</Badge>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", gap: "var(--space-2)" }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          void cronUpdate(job.id, { enabled: !job.enabled });
                        }}
                      >
                        {job.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          void cronRun({ id: job.id, mode: "force" });
                        }}
                      >
                        Run Now
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (confirm(`Delete job "${job.name}"?`)) {
                            void cronRemove(job.id);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  <div className="card-body">
                    <div className="kv-list">
                      {job.description ? (
                        <div className="kv-row">
                          <span className="kv-key">Description</span>
                          <span className="kv-value">{job.description}</span>
                        </div>
                      ) : null}
                      <div className="kv-row">
                        <span className="kv-key">Agent</span>
                        <span className="kv-value mono">{job.agentId}</span>
                      </div>
                      <div className="kv-row">
                        <span className="kv-key">Schedule</span>
                        <span className="kv-value mono">{formatSchedule(job.schedule)}</span>
                      </div>
                      <div className="kv-row">
                        <span className="kv-key">Mode</span>
                        <span className="kv-value">{job.spec.mode}</span>
                      </div>
                      <div className="kv-row">
                        <span className="kv-key">Message</span>
                        <span
                          className="kv-value"
                          style={{
                            maxWidth: 400,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {job.spec.mode === "task" ? job.spec.message : job.spec.text}
                        </span>
                      </div>
                      {job.state.nextRunAtMs ? (
                        <div className="kv-row">
                          <span className="kv-key">Next Run</span>
                          <span className="kv-value">{relativeTime(job.state.nextRunAtMs)}</span>
                        </div>
                      ) : null}
                      {job.state.lastRunAtMs ? (
                        <div className="kv-row">
                          <span className="kv-key">Last Run</span>
                          <span className="kv-value">{relativeTime(job.state.lastRunAtMs)}</span>
                        </div>
                      ) : null}
                      {job.state.lastError ? (
                        <div className="kv-row">
                          <span className="kv-key">Last Error</span>
                          <span className="kv-value" style={{ color: "var(--accent-danger)" }}>
                            {job.state.lastError}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">⏰</div>
            <div className="empty-state-title">No Cron Jobs</div>
            <div className="empty-state-description">
              Create a scheduled job to run agent tasks on a timer.
            </div>
          </div>
        )
      ) : cronTab === "runs" ? (
        cronRuns.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Job ID</th>
                <th>Status</th>
                <th>Time</th>
                <th>Duration</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {cronRuns.map((run) => (
                <tr key={`${run.id}-${run.ts}`}>
                  <td className="mono" style={{ fontSize: "var(--font-size-xs)" }}>
                    {run.jobId.slice(0, 12)}
                  </td>
                  <td>
                    <StatusPill status={run.status} />
                  </td>
                  <td>{relativeTime(run.ts)}</td>
                  <td>
                    {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "-"}
                  </td>
                  <td
                    style={{
                      maxWidth: 300,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {run.error ? (
                      <span style={{ color: "var(--accent-danger)" }}>{run.error}</span>
                    ) : (
                      run.summary || "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">📄</div>
            <div className="empty-state-title">No Run History</div>
            <div className="empty-state-description">
              Cron job runs will appear here after execution.
            </div>
          </div>
        )
      ) : (
        <CreateCronForm />
      )}
    </div>
  );
}
