import type { AppElementContext, GsvAppElement } from "./app-sdk";
import {
  OPEN_CHAT_PROCESS_EVENT,
  normalizeProcessId,
  type OpenChatProcessEventDetail,
} from "./chat-process-link";

type ProcListEntry = {
  pid: string;
  uid: number;
  parentPid: string | null;
  state: string;
  label: string | null;
  createdAt: number;
};

type ProcListResult = {
  processes?: ProcListEntry[];
};

type ProcessViewState = "ready" | "working" | "error" | "offline";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestampMs(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

class GsvProcessesAppElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private processes: ProcListEntry[] = [];
  private query = "";
  private kernelState: "disconnected" | "connecting" | "connected" = "disconnected";
  private isLoading = false;
  private isMutating = false;
  private mutatingPid: string | null = null;
  private suspended = false;
  private statusKind: "idle" | "error" = "idle";
  private statusText = "";
  private refreshTimer: number | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionNode = target.closest<HTMLElement>("[data-action]");
    if (!actionNode) {
      return;
    }

    const action = actionNode.dataset.action;
    if (!action) {
      return;
    }

    if (action === "refresh") {
      void this.loadProcesses();
      return;
    }

    if (action === "open-chat") {
      const pid = normalizeProcessId(actionNode.dataset.pid);
      if (!pid) {
        return;
      }
      this.openChatForProcess(pid);
      return;
    }

    if (action === "kill") {
      const pid = normalizeProcessId(actionNode.dataset.pid);
      if (!pid) {
        return;
      }
      void this.killProcess(pid);
    }
  };

  private readonly onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (target.dataset.field !== "query") {
      return;
    }

    this.query = target.value;
    this.render();
  };

  async gsvMount(context: AppElementContext): Promise<void> {
    this.context = context;
    this.suspended = false;
    this.kernelState = context.kernel.getStatus().state;

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      this.kernelState = status.state;
      if (status.state === "connected" && !this.suspended) {
        this.startAutoRefresh();
      } else {
        this.stopAutoRefresh();
      }
      this.render();
    });

    this.addEventListener("click", this.onClick);
    this.addEventListener("input", this.onInput);

    this.render();
    if (this.kernelState === "connected") {
      await this.loadProcesses();
      this.startAutoRefresh();
    }
  }

  async gsvSuspend(): Promise<void> {
    this.suspended = true;
    this.stopAutoRefresh();
    this.render();
  }

  async gsvResume(): Promise<void> {
    this.suspended = false;
    if (this.kernelState === "connected") {
      this.startAutoRefresh();
      await this.loadProcesses();
    }
    this.render();
  }

  async gsvUnmount(): Promise<void> {
    this.stopAutoRefresh();
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("input", this.onInput);
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.context = null;
    this.processes = [];
    this.query = "";
    this.statusKind = "idle";
    this.statusText = "";
    this.isLoading = false;
    this.isMutating = false;
    this.mutatingPid = null;
  }

  private startAutoRefresh(): void {
    if (this.refreshTimer !== null) {
      return;
    }

    this.refreshTimer = window.setInterval(() => {
      if (this.isLoading || this.isMutating || this.suspended || this.kernelState !== "connected") {
        return;
      }
      void this.loadProcesses();
    }, 10_000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer === null) {
      return;
    }
    window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private setStatus(kind: "idle" | "error", text: string): void {
    this.statusKind = kind;
    this.statusText = text;
  }

  private describeViewState(): { kind: ProcessViewState; label: string; detail: string } {
    if (this.kernelState !== "connected") {
      return {
        kind: "offline",
        label: "offline",
        detail: "Kernel is not connected.",
      };
    }

    if (this.statusKind === "error" && this.statusText.length > 0) {
      return {
        kind: "error",
        label: "error",
        detail: this.statusText,
      };
    }

    if (this.isLoading || this.isMutating) {
      return {
        kind: "working",
        label: this.isMutating ? "updating" : "refreshing",
        detail: this.isMutating ? "Updating process state." : "Refreshing process list.",
      };
    }

    return {
      kind: "ready",
      label: "ready",
      detail: "Process list is up to date.",
    };
  }

  private filteredProcesses(): ProcListEntry[] {
    const query = this.query.trim().toLowerCase();
    if (!query) {
      return this.processes;
    }

    return this.processes.filter((entry) => {
      return (
        entry.pid.toLowerCase().includes(query) ||
        (entry.label ?? "").toLowerCase().includes(query) ||
        (entry.parentPid ?? "").toLowerCase().includes(query)
      );
    });
  }

  private async loadProcesses(): Promise<void> {
    const context = this.context;
    if (!context || this.suspended || this.kernelState !== "connected") {
      return;
    }

    this.isLoading = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const payload = await context.kernel.request<ProcListResult>("proc.list", {});
      const next = Array.isArray(payload.processes) ? payload.processes : [];
      this.processes = [...next].sort((left, right) => right.createdAt - left.createdAt);
      this.setStatus("idle", "");
    } catch (error) {
      this.processes = [];
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private async killProcess(pid: string): Promise<void> {
    const context = this.context;
    if (!context || this.suspended || this.kernelState !== "connected" || this.isMutating) {
      return;
    }

    this.isMutating = true;
    this.mutatingPid = pid;
    this.setStatus("idle", "");
    this.render();

    try {
      await context.kernel.request("proc.kill", { pid });
      await this.loadProcesses();
      this.setStatus("idle", "");
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isMutating = false;
      this.mutatingPid = null;
      this.render();
    }
  }

  private openChatForProcess(pid: string): void {
    const detail: OpenChatProcessEventDetail = { pid };
    window.dispatchEvent(new CustomEvent<OpenChatProcessEventDetail>(OPEN_CHAT_PROCESS_EVENT, { detail }));
  }

  private renderProcessRows(): string {
    const rows = this.filteredProcesses();
    if (rows.length === 0) {
      return `<p class="config-empty muted">No processes match the current filter.</p>`;
    }

    return rows
      .map((entry) => {
        const state = entry.state.trim().toLowerCase();
        const stateClass = state === "running" ? "is-running" : state === "paused" ? "is-paused" : "is-other";
        const canAct = !this.isLoading && !this.isMutating && this.kernelState === "connected" && !this.suspended;
        const isMutatingThisRow = this.mutatingPid === entry.pid;
        const title = entry.label && entry.label.trim().length > 0 ? entry.label.trim() : entry.pid;

        return `
          <article class="process-row">
            <div class="process-row-main">
              <div class="process-row-head">
                <h3>${escapeHtml(title)}</h3>
                <span class="process-state-pill ${stateClass}">${escapeHtml(state || "unknown")}</span>
              </div>
              <p class="muted process-row-meta"><code>${escapeHtml(entry.pid)}</code> · uid ${entry.uid}</p>
              <p class="muted process-row-meta">parent ${escapeHtml(entry.parentPid ?? "—")} · created ${escapeHtml(formatTimestampMs(entry.createdAt))}</p>
            </div>
            <div class="process-row-actions">
              <button
                type="button"
                class="runtime-btn"
                data-action="open-chat"
                data-pid="${escapeHtml(entry.pid)}"
                ${canAct ? "" : "disabled"}
              >
                Open in Chat
              </button>
              <button
                type="button"
                class="runtime-btn"
                data-action="kill"
                data-pid="${escapeHtml(entry.pid)}"
                ${canAct ? "" : "disabled"}
              >
                ${isMutatingThisRow ? "Resetting..." : "Reset"}
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  private render(): void {
    const context = this.context;
    if (!context) {
      this.innerHTML = "";
      return;
    }

    const viewState = this.describeViewState();
    const refreshLabel = this.isLoading ? "Refreshing processes" : "Refresh processes";

    this.innerHTML = `
      <section class="app-grid process-app">
        <header class="process-page-header">
          <div class="process-page-copy">
            <p class="eyebrow">Process Surface</p>
            <h1>Processes</h1>
            <p>Inspect process state and jump directly into a process conversation in Chat.</p>
          </div>
          <div class="process-toolbar-row">
            <span class="config-state-icon is-${escapeHtml(viewState.kind)}" title="${escapeHtml(viewState.detail)}" aria-label="${escapeHtml(viewState.label)}">
              <span class="config-state-dot" aria-hidden="true"></span>
            </span>
            <button
              type="button"
              class="runtime-btn config-icon-btn${this.isLoading ? " is-busy" : ""}"
              data-action="refresh"
              title="${escapeHtml(refreshLabel)}"
              aria-label="${escapeHtml(refreshLabel)}"
              ${this.isLoading || this.isMutating || this.suspended || this.kernelState !== "connected" ? "disabled" : ""}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </header>

        <section class="process-toolbar">
          <label>
            Search
            <input
              data-field="query"
              type="text"
              value="${escapeHtml(this.query)}"
              placeholder="Filter by pid, label, or parent pid"
              ${this.suspended ? "disabled" : ""}
            />
          </label>
        </section>

        <section class="process-list">
          ${this.renderProcessRows()}
        </section>

        ${this.statusKind === "error" && this.statusText
          ? `<p class="control-error-text">${escapeHtml(this.statusText)}</p>`
          : ""}
      </section>
    `;
  }
}

export function ensureProcessManagerAppRegistered(): void {
  if (!customElements.get("gsv-processes-app")) {
    customElements.define("gsv-processes-app", GsvProcessesAppElement);
  }
}
