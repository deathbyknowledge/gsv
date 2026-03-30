import type { AppElementContext, GsvAppElement } from "../app-sdk";
import type { PkgListResult, PkgSummary } from "../../../src/syscalls/packages";

type PackagesViewState = "ready" | "loading" | "error" | "offline";
type PackagesStatusKind = "idle" | "error";

function defineElement(tagName: string, constructor: CustomElementConstructor): void {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, constructor);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestampMs(value: number): string {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  return new Date(value).toLocaleString();
}

function describePackageKind(entry: PkgSummary): string {
  if (entry.entrypoints.some((item) => item.kind === "ui")) {
    return "app";
  }
  if (entry.entrypoints.some((item) => item.kind === "command")) {
    return "bin";
  }
  return entry.runtime;
}

class GsvPackagesAppElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private kernelState: "disconnected" | "connecting" | "connected" = "disconnected";
  private suspended = false;
  private isLoading = false;
  private statusKind: PackagesStatusKind = "idle";
  private statusText = "";
  private packages: PkgSummary[] = [];

  gsvMount(context: AppElementContext): void {
    this.context = context;
    this.kernelState = "connected";
    void this.loadPackages();
  }

  gsvSuspend(): void {
    this.suspended = true;
    this.render();
  }

  gsvResume(): void {
    this.suspended = false;
    this.render();
  }

  gsvUnmount(): void {
    this.context = null;
    this.packages = [];
  }

  private setStatus(kind: PackagesStatusKind, text: string): void {
    this.statusKind = kind;
    this.statusText = text;
  }

  private describeViewState(): { kind: PackagesViewState; label: string; detail: string } {
    if (this.kernelState !== "connected") {
      return {
        kind: "offline",
        label: "offline",
        detail: "Kernel connection is unavailable.",
      };
    }
    if (this.statusKind === "error") {
      return {
        kind: "error",
        label: "error",
        detail: this.statusText || "Failed to load packages.",
      };
    }
    if (this.isLoading) {
      return {
        kind: "loading",
        label: "loading",
        detail: "Refreshing package list.",
      };
    }

    return {
      kind: "ready",
      label: "ready",
      detail: `${this.packages.length} package${this.packages.length === 1 ? "" : "s"} loaded.`,
    };
  }

  private async loadPackages(): Promise<void> {
    const context = this.context;
    if (!context || this.suspended || this.kernelState !== "connected") {
      return;
    }

    this.isLoading = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const payload = await context.kernel.request<PkgListResult>("pkg.list", {});
      const packages = Array.isArray(payload.packages) ? payload.packages : [];
      this.packages = [...packages].sort((left, right) => {
        if (left.name === right.name) {
          return right.version.localeCompare(left.version);
        }
        return left.name.localeCompare(right.name);
      });
      this.setStatus("idle", "");
    } catch (error) {
      this.packages = [];
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private renderPackageCards(): string {
    if (this.packages.length === 0) {
      return `<p class="config-empty muted">No packages are installed yet.</p>`;
    }

    return this.packages
      .map((entry) => {
        const kind = describePackageKind(entry);
        const bindings = entry.bindingNames
          .map((binding) => `<span class="app-tag">${escapeHtml(binding)}</span>`)
          .join("");
        const entrypoints = entry.entrypoints
          .map((item) => {
            const bits = [
              item.kind,
              item.command ?? item.route ?? item.name,
            ].filter(Boolean);
            return `<span class="app-tag">${escapeHtml(bits.join(" · "))}</span>`;
          })
          .join("");

        return `
          <article>
            <div class="app-tag-row">
              <span class="app-tag">${escapeHtml(kind)}</span>
              <span class="app-tag">${escapeHtml(entry.runtime)}</span>
              <span class="app-tag">${entry.enabled ? "enabled" : "disabled"}</span>
              <span class="app-tag">v${escapeHtml(entry.version)}</span>
            </div>
            <h2>${escapeHtml(entry.name)}</h2>
            <p>${escapeHtml(entry.description)}</p>
            <p class="muted"><code>${escapeHtml(entry.packageId)}</code></p>
            <div class="app-tag-row">${entrypoints}</div>
            <div class="app-tag-row">${bindings || '<span class="app-tag">no bindings</span>'}</div>
            <p class="muted">source ${escapeHtml(`${entry.source.repo}#${entry.source.ref}:${entry.source.subdir}`)} · installed ${escapeHtml(formatTimestampMs(entry.installedAt))}</p>
          </article>
        `;
      })
      .join("");
  }

  private render(): void {
    const state = this.describeViewState();

    this.innerHTML = `
      <section class="app-grid packages-app">
        <header>
          <p class="eyebrow">Package Manager</p>
          <h1>Packages</h1>
          <p>Live package inventory from the kernel package store.</p>
          <div class="app-tag-row">
            <span class="app-tag">${escapeHtml(state.label)}</span>
            <span class="app-tag">pkg.list</span>
            <span class="app-tag">${this.packages.length} installed</span>
          </div>
          <p class="muted">${escapeHtml(state.detail)}</p>
        </header>
        <div class="mock-grid">
          <article>
            <h2>Installed packages</h2>
            <p>These come from kernel-managed package records, including built-ins seeded at boot.</p>
            <div class="mock-grid">
              ${this.renderPackageCards()}
            </div>
          </article>
          <article>
            <h2>Why this matters</h2>
            <p>The desktop shell can now discover app packages from kernel data instead of a hardcoded UI-only registry.</p>
            <p>The next step is to hydrate launcher entries from <code>pkg.list</code> UI entrypoints.</p>
          </article>
        </div>
      </section>
    `;
  }
}

export function ensurePackagesAppRegistered(): void {
  defineElement("gsv-packages-app", GsvPackagesAppElement);
}
