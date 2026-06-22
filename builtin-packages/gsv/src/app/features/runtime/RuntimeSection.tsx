import { useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { ActionButton } from "../../components/ui/ActionButton";
import { TaskBoard, sortTaskProcesses, type TaskSort } from "./TaskBoard";
import { useRuntimeProcesses } from "./useRuntimeProcesses";

export function RuntimeSection({ backend }: { backend: GsvBackend }) {
  const runtime = useRuntimeProcesses(backend);
  const [sort, setSort] = useState<TaskSort>("agent");
  const hasFilter = runtime.query.trim().length > 0;
  const sortedProcesses = useMemo(() => sortTaskProcesses(runtime.filteredProcesses, sort), [runtime.filteredProcesses, sort]);
  const selectedExists = sortedProcesses.some((process) => String(process.pid ?? "").trim() === runtime.selectedPid);
  const selectedPid = selectedExists ? runtime.selectedPid ?? "" : sortedProcesses[0]?.pid || "";
  const statusText = runtime.loading
    ? `Refreshing. Showing ${runtime.filteredProcesses.length} of ${runtime.totalCount} tasks.`
    : `Showing ${runtime.filteredProcesses.length} of ${runtime.totalCount} tasks.`;

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
          <label class="gsv-runtime-search is-compact">
            <span>Sort by</span>
            <select value={sort} onChange={(event) => setSort(event.currentTarget.value as TaskSort)}>
              <option value="agent">Agent</option>
              <option value="status">Status</option>
              <option value="created">Date created</option>
              <option value="updated">Date updated</option>
            </select>
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
              systemAiValues={runtime.systemAiValues}
              processes={sortedProcesses}
              loading={runtime.loading}
              selectedPid={selectedPid}
              killingPid={runtime.killingPid}
              onToggle={(process) => {
                const pid = String(process.pid ?? "").trim();
                if (!pid) return;
                if (pid === runtime.selectedPid) {
                  runtime.clearSelection();
                  return;
                }
                runtime.selectProcess(process);
              }}
              onCancelTask={(pid) => void runtime.killProcess(pid)}
            />
          )}
        </div>
      </section>
    </section>
  );
}
