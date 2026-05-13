import { openApp } from "@gsv/package/host";
import type { GsvBackend } from "../../backend-contract";
import { formatTimestampMs } from "../../utils/format";
import {
  canOpenChat,
  processState,
  processStateTone,
  processTitle,
} from "./runtime-domain";
import { useRuntimeProcesses } from "./useRuntimeProcesses";
import type { ProcessEntry } from "./types";

export function RuntimeSection({ backend }: { backend: GsvBackend }) {
  const runtime = useRuntimeProcesses(backend);
  const hasFilter = runtime.query.trim().length > 0;
  const selectedProcess = runtime.selectedProcess;
  const statusText = runtime.loading
    ? `Refreshing. Showing ${runtime.filteredProcesses.length} of ${runtime.totalCount} processes.`
    : `Showing ${runtime.filteredProcesses.length} of ${runtime.totalCount} processes.`;

  return (
    <section class="gsv-runtime">
      <section class="gsv-runtime-list-pane" aria-label="Runtime processes">
        <form
          class="gsv-runtime-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget as HTMLFormElement;
            const input = form.elements.namedItem("runtime-search") as HTMLInputElement | null;
            runtime.setQuery(input?.value ?? "");
          }}
        >
          <label class="gsv-runtime-search">
            <span>Search</span>
            <input
              name="runtime-search"
              type="search"
              value={runtime.query}
              placeholder="pid, label, profile, workspace"
              onInput={(event) => runtime.setQuery(event.currentTarget.value)}
            />
          </label>
          <button class="gsv-mini-button" type="button" disabled={runtime.loading} onClick={() => void runtime.loadState()}>
            {runtime.loading ? "Refreshing" : "Refresh"}
          </button>
        </form>

        <p class="gsv-runtime-meta" aria-live="polite">{statusText}</p>
        {runtime.errorText ? <p class="gsv-inline-error">{runtime.errorText}</p> : null}

        <div class="gsv-runtime-list" aria-busy={runtime.loading ? "true" : "false"}>
          {runtime.filteredProcesses.length === 0 ? (
            <section class="gsv-empty-state">
              <h3>{hasFilter ? "No matching processes" : "No running processes"}</h3>
              <p>{hasFilter ? "Change the filter or clear search." : "Refresh to check for newly started processes."}</p>
            </section>
          ) : runtime.filteredProcesses.map((process) => (
            <ProcessRow
              key={process.pid}
              process={process}
              selected={selectedProcess?.pid === process.pid}
              onSelect={() => runtime.selectProcess(process)}
            />
          ))}
        </div>
      </section>

      <ProcessDetail
        process={selectedProcess}
        killingPid={runtime.killingPid}
        onKill={(pid) => void runtime.killProcess(pid)}
      />
    </section>
  );
}

function ProcessRow({
  process,
  selected,
  onSelect,
}: {
  process: ProcessEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const title = processTitle(process);
  const state = processState(process);
  const tone = processStateTone(process);
  const workspace = String(process.workspaceId ?? "").trim() || "No workspace";

  return (
    <button class={`gsv-runtime-row${selected ? " is-selected" : ""}`} type="button" onClick={onSelect}>
      <span class={`gsv-mark is-${tone}`} aria-hidden="true"></span>
      <span class="gsv-row-copy">
        <strong>{title}</strong>
        <span>{state} / {workspace}</span>
      </span>
      <span class="gsv-row-meta">{String(process.profile ?? "profile")}</span>
    </button>
  );
}

function ProcessDetail({
  process,
  killingPid,
  onKill,
}: {
  process: ProcessEntry | null;
  killingPid: string;
  onKill: (pid: string) => void;
}) {
  if (!process) {
    return (
      <section class="gsv-runtime-detail">
        <div class="gsv-empty-state">
          <h3>No process selected</h3>
          <p>Select a process to inspect its workspace, profile, and actions.</p>
        </div>
      </section>
    );
  }

  const pid = String(process.pid ?? "").trim();
  const title = processTitle(process);
  const cwd = String(process.cwd ?? "").trim();
  const workspaceId = String(process.workspaceId ?? "").trim();
  const killPending = killingPid === pid;

  return (
    <section class="gsv-runtime-detail" aria-label="Process detail">
      <header class="gsv-runtime-detail-head">
        <span class="gsv-kicker">Process detail</span>
        <h3>{title}</h3>
        <p>{pid}</p>
      </header>

      <dl class="gsv-detail-list">
        <div>
          <dt>State</dt>
          <dd>{processState(process)}</dd>
        </div>
        <div>
          <dt>Profile</dt>
          <dd>{String(process.profile ?? "unknown")}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>uid {String(process.uid ?? "?")}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>{process.parentPid == null ? "none" : String(process.parentPid)}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{workspaceId || "none"}</dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd><code>{cwd || "none"}</code></dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatTimestampMs(process.createdAt)}</dd>
        </div>
      </dl>

      <div class="gsv-detail-actions">
        <button
          class="gsv-action-button"
          type="button"
          disabled={!canOpenChat(process)}
          onClick={() => openApp({
            target: "chat",
            payload: { pid, cwd, workspaceId: workspaceId || null },
          })}
        >
          Open in Chat
        </button>
        <button
          class="gsv-action-button is-danger"
          type="button"
          disabled={!pid || Boolean(killingPid)}
          onClick={() => {
            if (window.confirm(`Kill process ${title}?\n\nThis stops the process immediately.`)) {
              onKill(pid);
            }
          }}
        >
          {killPending ? "Killing" : "Kill Process"}
        </button>
      </div>
    </section>
  );
}
