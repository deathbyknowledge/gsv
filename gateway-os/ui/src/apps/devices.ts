import type { AppElementContext, GsvAppElement } from "../app-sdk";

type DeviceSummary = {
  deviceId: string;
  ownerUid: number;
  platform: string;
  version: string;
  online: boolean;
  lastSeenAt: number;
};

type DeviceDetail = DeviceSummary & {
  implements: string[];
  firstSeenAt: number;
  connectedAt: number | null;
  disconnectedAt: number | null;
};

type DeviceListResult = {
  devices?: DeviceSummary[];
};

type DeviceGetResult = {
  device: DeviceDetail | null;
};

type DevicesViewState = "ready" | "working" | "error" | "offline";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestampMs(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

class GsvDevicesAppElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private kernelState: "disconnected" | "connecting" | "connected" = "disconnected";
  private devices: DeviceSummary[] = [];
  private selectedDeviceId: string | null = null;
  private selectedDeviceDetail: DeviceDetail | null = null;
  private query = "";
  private includeOffline = false;
  private isLoading = false;
  private isDetailLoading = false;
  private suspended = false;
  private statusKind: "idle" | "error" = "idle";
  private statusText = "";
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
      void this.loadDevices();
      return;
    }

    if (action === "select-device") {
      const deviceId = actionNode.dataset.deviceId ?? "";
      if (!deviceId) {
        return;
      }
      this.selectedDeviceId = deviceId;
      this.render();
      void this.loadSelectedDeviceDetail(deviceId);
      return;
    }

    if (action === "copy-target") {
      const targetValue = actionNode.dataset.target ?? "";
      void this.copyTarget(targetValue);
    }
  };

  private readonly onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const field = target.dataset.field;
    if (field === "query") {
      this.query = target.value;
      this.render();
      return;
    }

    if (field === "include-offline") {
      this.includeOffline = target.checked;
      void this.loadDevices();
    }
  };

  async gsvMount(context: AppElementContext): Promise<void> {
    this.context = context;
    this.suspended = false;
    this.kernelState = context.kernel.getStatus().state;

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      const prev = this.kernelState;
      this.kernelState = status.state;
      if (prev !== "connected" && status.state === "connected" && !this.suspended) {
        void this.loadDevices();
      }
      this.render();
    });

    this.addEventListener("click", this.onClick);
    this.addEventListener("input", this.onInput);

    this.render();
    if (this.kernelState === "connected") {
      await this.loadDevices();
    }
  }

  async gsvSuspend(): Promise<void> {
    this.suspended = true;
    this.render();
  }

  async gsvResume(): Promise<void> {
    this.suspended = false;
    if (this.kernelState === "connected") {
      await this.loadDevices();
    }
    this.render();
  }

  async gsvOnSignal(signal: string): Promise<void> {
    if (signal !== "device.status") {
      return;
    }
    if (this.suspended || this.kernelState !== "connected") {
      return;
    }
    await this.loadDevices();
  }

  async gsvUnmount(): Promise<void> {
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("input", this.onInput);
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;

    this.context = null;
    this.devices = [];
    this.selectedDeviceId = null;
    this.selectedDeviceDetail = null;
    this.query = "";
    this.includeOffline = false;
    this.isLoading = false;
    this.isDetailLoading = false;
    this.statusKind = "idle";
    this.statusText = "";
  }

  private setStatus(kind: "idle" | "error", text: string): void {
    this.statusKind = kind;
    this.statusText = text;
  }

  private describeViewState(): { kind: DevicesViewState; label: string; detail: string } {
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

    if (this.isLoading || this.isDetailLoading) {
      return {
        kind: "working",
        label: "refreshing",
        detail: "Refreshing device inventory.",
      };
    }

    return {
      kind: "ready",
      label: "ready",
      detail: "Device inventory is up to date.",
    };
  }

  private filteredDevices(): DeviceSummary[] {
    const query = this.query.trim().toLowerCase();
    if (!query) {
      return this.devices;
    }

    return this.devices.filter((device) => {
      return (
        device.deviceId.toLowerCase().includes(query) ||
        device.platform.toLowerCase().includes(query) ||
        device.version.toLowerCase().includes(query)
      );
    });
  }

  private async loadDevices(): Promise<void> {
    const context = this.context;
    if (!context || this.suspended || this.kernelState !== "connected") {
      return;
    }

    this.isLoading = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const payload = await context.kernel.request<DeviceListResult>("sys.device.list", {
        includeOffline: this.includeOffline,
      });
      const next = Array.isArray(payload.devices) ? payload.devices : [];
      next.sort((left, right) => {
        if (left.online !== right.online) {
          return left.online ? -1 : 1;
        }
        return left.deviceId.localeCompare(right.deviceId);
      });
      this.devices = next;

      const stillSelected = this.selectedDeviceId
        ? next.some((device) => device.deviceId === this.selectedDeviceId)
        : false;
      this.selectedDeviceId = stillSelected ? this.selectedDeviceId : next[0]?.deviceId ?? null;

      if (this.selectedDeviceId) {
        await this.loadSelectedDeviceDetail(this.selectedDeviceId);
      } else {
        this.selectedDeviceDetail = null;
      }

      this.setStatus("idle", "");
    } catch (error) {
      this.devices = [];
      this.selectedDeviceId = null;
      this.selectedDeviceDetail = null;
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private async loadSelectedDeviceDetail(deviceId: string): Promise<void> {
    const context = this.context;
    if (!context || this.suspended || this.kernelState !== "connected") {
      return;
    }

    this.isDetailLoading = true;
    this.render();

    try {
      const payload = await context.kernel.request<DeviceGetResult>("sys.device.get", { deviceId });
      if (this.selectedDeviceId !== deviceId) {
        return;
      }
      this.selectedDeviceDetail = payload.device;
    } catch (error) {
      this.selectedDeviceDetail = null;
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isDetailLoading = false;
      this.render();
    }
  }

  private async copyTarget(targetValue: string): Promise<void> {
    if (!targetValue || this.suspended) {
      return;
    }

    try {
      await navigator.clipboard.writeText(targetValue);
      this.setStatus("idle", "");
    } catch (error) {
      this.setStatus("error", `Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.render();
    }
  }

  private renderListRows(): string {
    const rows = this.filteredDevices();
    if (rows.length === 0) {
      return `<p class="config-empty muted">No devices match the current filter.</p>`;
    }

    return rows
      .map((device) => {
        const activeClass = this.selectedDeviceId === device.deviceId ? " is-active" : "";
        const statusClass = device.online ? "is-online" : "is-offline";

        return `
          <button
            type="button"
            class="device-row${activeClass}"
            data-action="select-device"
            data-device-id="${escapeHtml(device.deviceId)}"
          >
            <div class="device-row-head">
              <strong>${escapeHtml(device.deviceId)}</strong>
              <span class="device-status-pill ${statusClass}">${device.online ? "online" : "offline"}</span>
            </div>
            <p class="muted">${escapeHtml(device.platform)} · ${escapeHtml(device.version)}</p>
            <p class="muted">last seen ${escapeHtml(formatTimestampMs(device.lastSeenAt))}</p>
          </button>
        `;
      })
      .join("");
  }

  private renderDetail(): string {
    if (!this.selectedDeviceId) {
      return `<p class="config-empty muted">Select a device to view details.</p>`;
    }

    if (this.isDetailLoading) {
      return `<p class="config-empty muted">Loading device details...</p>`;
    }

    const detail = this.selectedDeviceDetail;
    if (!detail) {
      return `<p class="config-empty muted">Device details are unavailable for the selected entry.</p>`;
    }

    const targetValue = `device:${detail.deviceId}`;
    const implementsTags = detail.implements.length > 0
      ? detail.implements.map((entry) => `<span class="app-tag">${escapeHtml(entry)}</span>`).join("")
      : `<span class="muted">No capabilities advertised.</span>`;

    return `
      <section class="device-detail">
        <header class="device-detail-header">
          <h3>${escapeHtml(detail.deviceId)}</h3>
          <button
            type="button"
            class="runtime-btn"
            data-action="copy-target"
            data-target="${escapeHtml(targetValue)}"
            ${this.suspended ? "disabled" : ""}
          >
            Copy Target
          </button>
        </header>

        <div class="device-detail-grid">
          <article class="device-detail-item">
            <h4>Status</h4>
            <p>${detail.online ? "Online" : "Offline"}</p>
          </article>
          <article class="device-detail-item">
            <h4>Owner UID</h4>
            <p>${detail.ownerUid}</p>
          </article>
          <article class="device-detail-item">
            <h4>Platform</h4>
            <p>${escapeHtml(detail.platform)}</p>
          </article>
          <article class="device-detail-item">
            <h4>Version</h4>
            <p>${escapeHtml(detail.version)}</p>
          </article>
          <article class="device-detail-item">
            <h4>First Seen</h4>
            <p>${escapeHtml(formatTimestampMs(detail.firstSeenAt))}</p>
          </article>
          <article class="device-detail-item">
            <h4>Last Seen</h4>
            <p>${escapeHtml(formatTimestampMs(detail.lastSeenAt))}</p>
          </article>
          <article class="device-detail-item">
            <h4>Connected At</h4>
            <p>${escapeHtml(formatTimestampMs(detail.connectedAt))}</p>
          </article>
          <article class="device-detail-item">
            <h4>Disconnected At</h4>
            <p>${escapeHtml(formatTimestampMs(detail.disconnectedAt))}</p>
          </article>
        </div>

        <section class="device-implements">
          <h4>Implements</h4>
          <div class="app-tag-row">${implementsTags}</div>
        </section>
      </section>
    `;
  }

  private render(): void {
    const context = this.context;
    if (!context) {
      this.innerHTML = "";
      return;
    }

    const viewState = this.describeViewState();
    const refreshLabel = this.isLoading ? "Refreshing devices" : "Refresh devices";

    this.innerHTML = `
      <section class="app-grid devices-app">
        <header class="devices-page-header">
          <div class="devices-page-copy">
            <p class="eyebrow">Device Surface</p>
            <h1>Devices</h1>
            <p>Inspect connected machines and copy routing targets for shell or tool execution.</p>
          </div>
          <div class="devices-toolbar-row">
            <span class="config-state-icon is-${escapeHtml(viewState.kind)}" title="${escapeHtml(viewState.detail)}" aria-label="${escapeHtml(viewState.label)}">
              <span class="config-state-dot" aria-hidden="true"></span>
            </span>
            <button
              type="button"
              class="runtime-btn config-icon-btn${this.isLoading ? " is-busy" : ""}"
              data-action="refresh"
              title="${escapeHtml(refreshLabel)}"
              aria-label="${escapeHtml(refreshLabel)}"
              ${this.isLoading || this.isDetailLoading || this.suspended || this.kernelState !== "connected" ? "disabled" : ""}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </header>

        <section class="devices-toolbar">
          <label>
            Search
            <input
              data-field="query"
              type="text"
              value="${escapeHtml(this.query)}"
              placeholder="Filter by id, platform, or version"
              ${this.suspended ? "disabled" : ""}
            />
          </label>
          <label class="config-checkbox">
            <input
              data-field="include-offline"
              type="checkbox"
              ${this.includeOffline ? "checked" : ""}
              ${this.suspended ? "disabled" : ""}
            />
            Show offline devices
          </label>
        </section>

        <section class="devices-layout">
          <div class="devices-list">
            ${this.renderListRows()}
          </div>
          <div class="devices-detail-panel">
            ${this.renderDetail()}
          </div>
        </section>

        ${this.statusKind === "error" && this.statusText
          ? `<p class="control-error-text">${escapeHtml(this.statusText)}</p>`
          : ""}
      </section>
    `;
  }
}

export function ensureDevicesAppRegistered(): void {
  if (!customElements.get("gsv-devices-app")) {
    customElements.define("gsv-devices-app", GsvDevicesAppElement);
  }
}
