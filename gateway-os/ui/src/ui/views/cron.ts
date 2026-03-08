/**
 * Cron Jobs View
 *
 * Displays cron status, job list with enable/disable/delete,
 * run history, and a form to create new jobs.
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";

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

function formatSchedule(s: CronSchedule): string {
  if (s.kind === "at") {
    return `Once at ${new Date(s.atMs).toLocaleString()}`;
  }
  if (s.kind === "every") {
    const ms = s.everyMs;
    if (ms >= 86400000) return `Every ${Math.round(ms / 86400000)}d`;
    if (ms >= 3600000) return `Every ${Math.round(ms / 3600000)}h`;
    if (ms >= 60000) return `Every ${Math.round(ms / 60000)}m`;
    return `Every ${Math.round(ms / 1000)}s`;
  }
  if (s.kind === "cron") {
    return `${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
  }
  return "Unknown";
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (Math.abs(diff) < 60000) return "just now";
  const future = diff < 0;
  const abs = Math.abs(diff);
  if (abs < 3600000) {
    const m = Math.round(abs / 60000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86400000) {
    const h = Math.round(abs / 3600000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86400000);
  return future ? `in ${d}d` : `${d}d ago`;
}

function statusPill(status?: string) {
  if (!status) return nothing;
  const cls =
    status === "ok"
      ? "pill-success"
      : status === "error"
        ? "pill-danger"
        : "pill-warning";
  return html`<span class="pill ${cls}">${status}</span>`;
}

export function renderCron(app: GsvApp) {
  const status = (app as any).cronStatus as CronStatus | null;
  const jobs = (app as any).cronJobs as CronJob[];
  const runs = (app as any).cronRuns as CronRun[];
  const loading = (app as any).cronLoading as boolean;
  const cronTab = (app as any).cronTab as string || "jobs";

  return html`
    <div class="view-container">
      <!-- Status Banner -->
      ${status
        ? html`
            <div class="cards-grid" style="margin-bottom: var(--space-6);">
              <div class="card">
                <div class="card-body stat">
                  <div class="stat-value">${status.count}</div>
                  <div class="stat-label">Total Jobs</div>
                </div>
              </div>
              <div class="card">
                <div class="card-body stat">
                  <div class="stat-value">${status.dueCount}</div>
                  <div class="stat-label">Due Now</div>
                </div>
              </div>
              <div class="card">
                <div class="card-body stat">
                  <div class="stat-value">${status.runningCount}</div>
                  <div class="stat-label">Running</div>
                </div>
              </div>
              <div class="card">
                <div class="card-body stat">
                  <div class="stat-value">
                    ${status.enabled
                      ? html`<span style="color: var(--accent-success)">On</span>`
                      : html`<span style="color: var(--accent-danger)">Off</span>`}
                  </div>
                  <div class="stat-label">Cron Engine</div>
                </div>
              </div>
            </div>
          `
        : nothing}

      <!-- Tabs -->
      <div class="tabs">
        <div
          class="tab ${cronTab === "jobs" ? "active" : ""}"
          @click=${() => { (app as any).cronTab = "jobs"; app.requestUpdate(); }}
        >
          Jobs
        </div>
        <div
          class="tab ${cronTab === "runs" ? "active" : ""}"
          @click=${() => {
            (app as any).cronTab = "runs";
            app.requestUpdate();
            (app as any).loadCronRuns?.();
          }}
        >
          Run History
        </div>
        <div
          class="tab ${cronTab === "create" ? "active" : ""}"
          @click=${() => { (app as any).cronTab = "create"; app.requestUpdate(); }}
        >
          + New Job
        </div>
      </div>

      ${loading
        ? html`<div class="empty-state"><span class="spinner"></span> Loading...</div>`
        : cronTab === "jobs"
          ? renderJobsTab(app, jobs)
          : cronTab === "runs"
            ? renderRunsTab(app, runs)
            : renderCreateTab(app)}
    </div>
  `;
}

function renderJobsTab(app: GsvApp, jobs: CronJob[]) {
  if (!jobs.length) {
    return html`
      <div class="empty-state">
        <div class="empty-state-icon">&#128337;</div>
        <div class="empty-state-title">No Cron Jobs</div>
        <div class="empty-state-description">
          Create a scheduled job to run agent tasks on a timer.
        </div>
      </div>
    `;
  }

  return html`
    <div class="section-header">
      <span class="section-title">Jobs (${jobs.length})</span>
      <div style="display: flex; gap: var(--space-2);">
        <button
          class="btn btn-secondary btn-sm"
          @click=${() => (app as any).loadCron?.()}
        >
          Refresh
        </button>
        <button
          class="btn btn-primary btn-sm"
          @click=${async () => {
            if (confirm("Run all due cron jobs now?")) {
              await app.client?.cronRun({ mode: "due" });
              (app as any).loadCron?.();
            }
          }}
        >
          Run Due
        </button>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: var(--space-3);">
      ${jobs.map(
        (job) => html`
          <div class="card">
            <div class="card-header">
              <div style="display: flex; align-items: center; gap: var(--space-3);">
                <span class="card-title">${job.name}</span>
                <span class="pill ${job.enabled ? "pill-success" : ""}"
                  >${job.enabled ? "Enabled" : "Disabled"}</span
                >
                ${statusPill(job.state.lastStatus)}
                ${job.deleteAfterRun
                  ? html`<span class="pill pill-warning">One-shot</span>`
                  : nothing}
              </div>
              <div style="display: flex; gap: var(--space-2);">
                <button
                  class="btn btn-ghost btn-sm"
                  @click=${async () => {
                    await app.client?.cronUpdate(job.id, {
                      enabled: !job.enabled,
                    });
                    (app as any).loadCron?.();
                  }}
                >
                  ${job.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  @click=${async () => {
                    await app.client?.cronRun({ id: job.id, mode: "force" });
                    (app as any).loadCron?.();
                  }}
                >
                  Run Now
                </button>
                <button
                  class="btn btn-danger btn-sm"
                  @click=${async () => {
                    if (confirm(`Delete job "${job.name}"?`)) {
                      await app.client?.cronRemove(job.id);
                      (app as any).loadCron?.();
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
            <div class="card-body">
              <div class="kv-list">
                ${job.description
                  ? html`
                      <div class="kv-row">
                        <span class="kv-key">Description</span>
                        <span class="kv-value">${job.description}</span>
                      </div>
                    `
                  : nothing}
                <div class="kv-row">
                  <span class="kv-key">Agent</span>
                  <span class="kv-value mono">${job.agentId}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Schedule</span>
                  <span class="kv-value mono">${formatSchedule(job.schedule)}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Mode</span>
                  <span class="kv-value">${job.spec.mode}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Message</span>
                  <span class="kv-value" style="max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${job.spec.mode === "task" ? job.spec.message : job.spec.text}
                  </span>
                </div>
                ${job.state.nextRunAtMs
                  ? html`
                      <div class="kv-row">
                        <span class="kv-key">Next Run</span>
                        <span class="kv-value">${relativeTime(job.state.nextRunAtMs)}</span>
                      </div>
                    `
                  : nothing}
                ${job.state.lastRunAtMs
                  ? html`
                      <div class="kv-row">
                        <span class="kv-key">Last Run</span>
                        <span class="kv-value">${relativeTime(job.state.lastRunAtMs)}</span>
                      </div>
                    `
                  : nothing}
                ${job.state.lastError
                  ? html`
                      <div class="kv-row">
                        <span class="kv-key">Last Error</span>
                        <span class="kv-value" style="color: var(--accent-danger);">${job.state.lastError}</span>
                      </div>
                    `
                  : nothing}
              </div>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderRunsTab(_app: GsvApp, runs: CronRun[]) {
  if (!runs.length) {
    return html`
      <div class="empty-state">
        <div class="empty-state-icon">&#128196;</div>
        <div class="empty-state-title">No Run History</div>
        <div class="empty-state-description">
          Cron job runs will appear here after execution.
        </div>
      </div>
    `;
  }

  return html`
    <table class="table">
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
        ${runs.map(
          (run) => html`
            <tr>
              <td class="mono" style="font-size: var(--font-size-xs);">${run.jobId.slice(0, 12)}</td>
              <td>${statusPill(run.status)}</td>
              <td>${relativeTime(run.ts)}</td>
              <td>${run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "-"}</td>
              <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${run.error
                  ? html`<span style="color: var(--accent-danger);">${run.error}</span>`
                  : run.summary || "-"}
              </td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

function renderCreateTab(app: GsvApp) {
  return html`
    <div class="card" style="max-width: 600px;">
      <div class="card-header">
        <span class="card-title">Create Cron Job</span>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input type="text" class="form-input" id="cron-name" placeholder="daily-report" />
        </div>

        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" class="form-input" id="cron-description" placeholder="Optional description" />
        </div>

        <div class="form-group">
          <label class="form-label">Schedule Type</label>
          <select class="form-select" id="cron-schedule-kind">
            <option value="every">Interval (every N minutes)</option>
            <option value="cron">Cron Expression</option>
            <option value="at">One-time (at specific time)</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Schedule Value</label>
          <input
            type="text"
            class="form-input mono"
            id="cron-schedule-value"
            placeholder="30 (minutes) or */5 * * * * (cron) or ISO date"
          />
          <p class="form-hint">
            For "every": interval in minutes. For "cron": standard cron expression. For "at": ISO date string.
          </p>
        </div>

        <div class="form-group">
          <label class="form-label">Mode</label>
          <select class="form-select" id="cron-mode">
            <option value="task">Task (isolated session)</option>
            <option value="systemEvent">System Event (inject into main session)</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Message / Text</label>
          <textarea
            class="form-textarea"
            id="cron-message"
            rows="3"
            placeholder="The prompt or message for the agent"
          ></textarea>
        </div>

        <div class="form-group">
          <label style="display: flex; align-items: center; gap: var(--space-2); cursor: pointer;">
            <input type="checkbox" id="cron-delete-after" />
            <span class="form-label" style="margin: 0;">Delete after run (one-shot)</span>
          </label>
        </div>

        <button
          class="btn btn-primary"
          @click=${async () => {
            const name = (document.getElementById("cron-name") as HTMLInputElement)?.value?.trim();
            const description = (document.getElementById("cron-description") as HTMLInputElement)?.value?.trim();
            const schedKind = (document.getElementById("cron-schedule-kind") as HTMLSelectElement)?.value;
            const schedValue = (document.getElementById("cron-schedule-value") as HTMLInputElement)?.value?.trim();
            const mode = (document.getElementById("cron-mode") as HTMLSelectElement)?.value;
            const message = (document.getElementById("cron-message") as HTMLTextAreaElement)?.value?.trim();
            const deleteAfterRun = (document.getElementById("cron-delete-after") as HTMLInputElement)?.checked;

            if (!name || !schedValue || !message) {
              alert("Name, schedule value, and message are required.");
              return;
            }

            let schedule: Record<string, unknown>;
            if (schedKind === "every") {
              schedule = { kind: "every", everyMs: parseFloat(schedValue) * 60000 };
            } else if (schedKind === "cron") {
              schedule = { kind: "cron", expr: schedValue };
            } else {
              schedule = { kind: "at", atMs: new Date(schedValue).getTime() };
            }

            const spec: Record<string, unknown> =
              mode === "task"
                ? { mode: "task", message }
                : { mode: "systemEvent", text: message };

            try {
              await app.client?.cronAdd({
                name,
                description: description || undefined,
                enabled: true,
                deleteAfterRun,
                schedule,
                spec,
              });
              (app as any).cronTab = "jobs";
              (app as any).loadCron?.();
            } catch (e) {
              alert(`Failed to create job: ${e}`);
            }
          }}
        >
          Create Job
        </button>
      </div>
    </div>
  `;
}
