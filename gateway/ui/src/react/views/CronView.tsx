import { useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
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
    <div className="app-list" style={{ gap: "var(--space-4)", maxWidth: 760 }}>
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

      <div className="app-grid" style={{ gap: "var(--space-3)" }}>
        <div className="app-col-6 form-group">
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

        <div className="app-col-6 form-group">
          <Select<string>
            label="Mode"
            hideLabel={false}
            value={mode}
            onValueChange={(value) =>
              setMode(String(value || "task") as "task" | "systemEvent")
            }
          >
            <Select.Option value="task">Task (isolated session)</Select.Option>
            <Select.Option value="systemEvent">System Event (main session)</Select.Option>
          </Select>
        </div>
      </div>

      <div className="form-group">
        <Input
          label="Schedule Value"
          type="text"
          className="mono ui-input-fix"
          size="lg"
          value={scheduleValue}
          onChange={(event) => setScheduleValue(event.target.value)}
          placeholder="30 (minutes) | */5 * * * * | 2026-03-01T10:00:00Z"
        />
        <p className="form-hint" style={{ marginTop: "var(--space-1)" }}>
          Interval expects minutes. Cron expects expression. One-time expects ISO timestamp.
        </p>
      </div>

      <div className="form-group">
        <Textarea
          label="Message / Text"
          className="ui-input-fix"
          size="lg"
          rows={3}
          value={message}
          onValueChange={setMessage}
          placeholder="The prompt or event text to run"
        />
      </div>

      <div className="form-group">
        <Checkbox
          label="Delete after run (one-shot)"
          checked={deleteAfterRun}
          onCheckedChange={setDeleteAfterRun}
        />
      </div>

      <div className="app-actions">
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
      { label: "Jobs", value: cronStatus?.count ?? 0 },
      { label: "Due", value: cronStatus?.dueCount ?? 0 },
      { label: "Running", value: cronStatus?.runningCount ?? 0 },
      { label: "Engine", value: cronStatus?.enabled ? "On" : "Off" },
      {
        label: "Next Tick",
        value: cronStatus?.nextRunAtMs ? relativeTime(cronStatus.nextRunAtMs) : "—",
      },
    ],
    [cronStatus],
  );

  return (
    <div className="view-container">
      <div className="app-shell" data-app="cron">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">Scheduler</h2>
              <p className="app-hero-subtitle">
                Manage recurring and one-shot agent jobs, inspect execution history,
                and trigger immediate runs.
              </p>
            </div>
            <div className="app-actions">
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
        </section>

        {cronStatus ? (
          <section className="app-kpis">
            {stats.map((item) => (
              <article className="app-kpi" key={item.label}>
                <span className="app-kpi-label">{item.label}</span>
                <span className="app-kpi-value">{item.value}</span>
              </article>
            ))}
          </section>
        ) : null}

        <section className="app-panel" style={{ flex: 1, minHeight: 0 }}>
          <header className="app-panel-head">
            <div className="app-tabs" role="tablist" aria-label="Cron sections">
              {[
                { value: "jobs", label: "Jobs" },
                { value: "runs", label: "Run History" },
                { value: "create", label: "New Job" },
              ].map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={`app-tab ${cronTab === tab.value ? "active" : ""}`}
                  onClick={() => {
                    const nextTab = tab.value as "jobs" | "runs" | "create";
                    setCronTab(nextTab);
                    if (nextTab === "runs") {
                      void loadCronRuns();
                    }
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <span className="app-panel-meta">{cronLoading ? "loading" : "ready"}</span>
          </header>

          <div className="app-panel-body app-scroll">
            {cronLoading ? (
              <div className="app-empty" style={{ minHeight: 220 }}>
                <div>
                  <span className="spinner" />
                  <div style={{ marginTop: "var(--space-2)" }}>Loading scheduler data...</div>
                </div>
              </div>
            ) : cronTab === "jobs" ? (
              cronJobs.length ? (
                <div className="app-list">
                  {cronJobs.map((job) => (
                    <article className="app-list-item" key={job.id}>
                      <div className="app-list-head">
                        <div>
                          <div className="app-list-title">{job.name}</div>
                          <div className="app-list-subtitle">
                            {job.description || "No description"}
                          </div>
                        </div>
                        <div className="app-actions">
                          <Badge variant={job.enabled ? "primary" : "outline"}>
                            {job.enabled ? "enabled" : "disabled"}
                          </Badge>
                          <StatusPill status={job.state.lastStatus} />
                          {job.deleteAfterRun ? <Badge variant="outline">one-shot</Badge> : null}
                        </div>
                      </div>

                      <div className="app-list-meta">
                        <div className="app-meta-row">
                          <div className="app-meta-label">Agent</div>
                          <div className="app-meta-value mono">{job.agentId}</div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Schedule</div>
                          <div className="app-meta-value mono">{formatSchedule(job.schedule)}</div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Mode</div>
                          <div className="app-meta-value">{job.spec.mode}</div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Next Run</div>
                          <div className="app-meta-value">
                            {job.state.nextRunAtMs ? relativeTime(job.state.nextRunAtMs) : "—"}
                          </div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Last Run</div>
                          <div className="app-meta-value">
                            {job.state.lastRunAtMs ? relativeTime(job.state.lastRunAtMs) : "—"}
                          </div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Message</div>
                          <div className="app-meta-value">
                            {job.spec.mode === "task" ? job.spec.message : job.spec.text}
                          </div>
                        </div>
                      </div>

                      {job.state.lastError ? (
                        <p className="text-danger" style={{ marginTop: "var(--space-3)" }}>
                          Last error: {job.state.lastError}
                        </p>
                      ) : null}

                      <div className="app-actions" style={{ marginTop: "var(--space-3)" }}>
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
                    </article>
                  ))}
                </div>
              ) : (
                <div className="app-empty" style={{ minHeight: 220 }}>
                  <div>
                    <div className="app-empty-icon">⏰</div>
                    <div>No cron jobs</div>
                  </div>
                </div>
              )
            ) : cronTab === "runs" ? (
              cronRuns.length ? (
                <div className="app-list">
                  {cronRuns.map((run) => (
                    <article className="app-list-item" key={`${run.id}-${run.ts}`}>
                      <div className="app-list-head">
                        <div>
                          <div className="app-list-title mono">{run.jobId}</div>
                          <div className="app-list-subtitle">{relativeTime(run.ts)}</div>
                        </div>
                        <div className="app-actions">
                          <StatusPill status={run.status} />
                        </div>
                      </div>

                      <div className="app-list-meta">
                        <div className="app-meta-row">
                          <div className="app-meta-label">Duration</div>
                          <div className="app-meta-value">
                            {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}
                          </div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Summary</div>
                          <div className="app-meta-value">{run.summary || "—"}</div>
                        </div>
                        <div className="app-meta-row">
                          <div className="app-meta-label">Error</div>
                          <div className="app-meta-value">{run.error || "—"}</div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="app-empty" style={{ minHeight: 220 }}>
                  <div>
                    <div className="app-empty-icon">📄</div>
                    <div>No run history yet</div>
                  </div>
                </div>
              )
            ) : (
              <CreateCronForm />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
