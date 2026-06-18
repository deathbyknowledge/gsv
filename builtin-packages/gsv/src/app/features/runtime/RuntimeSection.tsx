import { openApp } from "@humansandmachines/gsv/sdk/host";
import type { GsvBackend } from "../../backend-contract";
import { ActionButton } from "../../components/ui/ActionButton";
import { formatTimestampMs } from "../../utils/format";
import {
  canOpenChat,
  processState,
  processTitle,
} from "./runtime-domain";
import { TaskBoard } from "./TaskBoard";
import { useRuntimeProcesses } from "./useRuntimeProcesses";
import type { ProcessEntry } from "./types";

export function RuntimeSection({ backend }: { backend: GsvBackend }) {
  const runtime = useRuntimeProcesses(backend);
  const hasFilter = runtime.query.trim().length > 0;
  const selectedProcess = runtime.selectedProcess;
  const statusText = runtime.loading
    ? `Refreshing. Showing ${runtime.filteredProcesses.length} of ${runtime.totalCount} tasks.`
    : `Showing ${runtime.filteredProcesses.length} of ${runtime.totalCount} tasks.`;

  if (selectedProcess) {
    return (
      <section class="gsv-runtime">
        <ProcessDetail
          process={selectedProcess}
          killingPid={runtime.killingPid}
          onBack={runtime.clearSelection}
          onKill={(pid) => void runtime.killProcess(pid)}
        />
      </section>
    );
  }

  return (
    <section class="gsv-runtime">
      <section class="gsv-runtime-list-pane" aria-label="Runtime tasks">
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
              placeholder="pid, label, profile, path"
              onInput={(event) => runtime.setQuery(event.currentTarget.value)}
            />
          </label>
          <ActionButton
            icon="refresh"
            label="Refresh"
            busyLabel="Refreshing"
            busy={runtime.loading}
            size="icon"
            onClick={() => void runtime.loadState()}
          />
        </form>

        <p class="gsv-runtime-meta" aria-live="polite">{statusText}</p>
        {runtime.errorText ? <p class="gsv-inline-error">{runtime.errorText}</p> : null}

        <div class="gsv-runtime-list" aria-busy={runtime.loading ? "true" : "false"}>
          {runtime.filteredProcesses.length === 0 ? (
            <section class="gsv-empty-state">
              <h3>{hasFilter ? "No matching tasks" : "No runtime tasks"}</h3>
              <p>{hasFilter ? "Change the filter or clear search." : "Refresh to check for newly started work."}</p>
            </section>
          ) : (
            <TaskBoard
              agents={runtime.agents}
              models={runtime.models}
              processes={runtime.filteredProcesses}
              loading={runtime.loading}
              onSelect={runtime.selectProcess}
            />
          )}
        </div>
      </section>
    </section>
  );
}

function ProcessDetail({
  process,
  killingPid,
  onBack,
  onKill,
}: {
  process: ProcessEntry | null;
  killingPid: string;
  onBack: () => void;
  onKill: (pid: string) => void;
}) {
  if (!process) {
    return (
      <section class="gsv-runtime-detail">
        <div class="gsv-empty-state">
          <h3>No process selected</h3>
          <p>Select a process to inspect its profile, cwd, and actions.</p>
        </div>
      </section>
    );
  }

  const pid = String(process.pid ?? "").trim();
  const title = processTitle(process);
  const cwd = String(process.cwd ?? "").trim();
  const killPending = killingPid === pid;

  return (
    <section class="gsv-runtime-detail" aria-label="Task detail">
      <header class="gsv-runtime-detail-head">
        <ActionButton icon="arrow-left" label="Tasks" onClick={onBack} />
        <div>
          <span class="gsv-kicker">Task detail</span>
          <h3>{title}</h3>
          <p>{pid}</p>
        </div>
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
          <dt>Cwd</dt>
          <dd><code>{cwd || "none"}</code></dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatTimestampMs(process.createdAt)}</dd>
        </div>
      </dl>

      <div class="gsv-detail-actions">
        <ActionButton
          icon="external"
          label="Open in Chat"
          size="full"
          disabled={!canOpenChat(process)}
          onClick={() => openApp({
            target: "chat",
            payload: { pid, cwd },
          })}
        />
        <ActionButton
          icon="trash"
          label="Cancel Task"
          busyLabel="Canceling"
          busy={killPending}
          variant="danger"
          size="full"
          disabled={!pid || Boolean(killingPid)}
          onClick={() => {
            if (window.confirm(`Kill process ${title}?\n\nThis stops the process immediately.`)) {
              onKill(pid);
            }
          }}
        />
      </div>
    </section>
  );
}
