import type { SysBootstrapResult } from "@humansandmachines/gsv/protocol";
import { RipgitClient, type RipgitRepoRef } from "../../fs/ripgit/client";
import type { KernelContext } from "../context";
import { registerRepo } from "../repo";
import { setRepoVisibility } from "../repo-visibility";
import manualVersion from "./manual-version.json";

const GSV_MANUAL_BOOTSTRAP_UPSTREAM_ENV = "GSV_MANUAL_BOOTSTRAP_UPSTREAM";
const GSV_MANUAL_BOOTSTRAP_REF_ENV = "GSV_MANUAL_BOOTSTRAP_REF";
const ROOT_GSV_MANUAL_REPO: RipgitRepoRef = { owner: "root", repo: "gsv-manual", branch: "main" };
const STATE_KEY = "manual_update";
const RETRY_AFTER_MS = 5 * 60_000;
type BootstrapUpstream = { remoteUrl: string; ref?: string };
type BootstrapRefSplit = { upstream: string; ref?: string };

export type ManualUpdateState = {
  source: string;
  status: "updating" | "current" | "diverged" | "failed";
  checkedAt: number;
  head: string | null;
};

export class ManualUpdater {
  private pending?: Promise<SysBootstrapResult>;

  constructor(
    private readonly storage: Pick<DurableObjectStorage, "kv">,
    private readonly ctx: Pick<KernelContext, "env" | "config">,
    private readonly canUpdate: () => Promise<boolean>,
  ) {}

  status(): ManualUpdateState | undefined {
    return this.storage.kv.get<ManualUpdateState>(STATE_KEY);
  }

  async ensureCurrent(): Promise<void> {
    if (!this.ctx.env.RIPGIT || !this.ctx.config.get("repos/root/gsv-manual/created_at")) return;
    try {
      const { remoteUrl, ref } = resolveManualUpstream(this.ctx.env);
      const previous = this.status();
      if (previous?.source === this.sourceKey(remoteUrl, ref)
        && (previous.status === "current" || previous.status === "diverged"
          || Date.now() - previous.checkedAt < RETRY_AFTER_MS)) return;
      await this.refresh(true);
    } catch {
      console.warn("[manual] Automatic update failed; keeping the installed copy");
    }
  }

  refresh(automatic = false): Promise<SysBootstrapResult> {
    if (this.pending) return this.pending;
    this.pending = this.update(automatic).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private sourceKey(remoteUrl: string, ref: string): string {
    return JSON.stringify([remoteUrl, ref, manualVersion.revision]);
  }

  private async update(automatic: boolean): Promise<SysBootstrapResult> {
    if (!this.ctx.env.RIPGIT) throw new Error("RIPGIT binding is required for system bootstrap");
    const { remoteUrl, ref } = resolveManualUpstream(this.ctx.env);
    const state: ManualUpdateState = {
      source: this.sourceKey(remoteUrl, ref), status: "updating",
      checkedAt: Date.now(), head: this.status()?.head ?? null,
    };
    this.storage.kv.put(STATE_KEY, state);
    try {
      // First-boot setup has its own onboarding authorization before ordinary
      // work is admitted. Only background updates need a separate admission.
      if (automatic && !await this.canUpdate()) throw new Error("Installation admission is closed");
      const imported = await new RipgitClient(this.ctx.env.RIPGIT).importFromUpstream(
        ROOT_GSV_MANUAL_REPO, "root", "root@gsv.local",
        "gsv: update manual", remoteUrl, ref,
      );
      if (!this.ctx.config.get("repos/root/gsv-manual/created_at")) {
        registerRepo(this.ctx, ROOT_GSV_MANUAL_REPO, "GSV Manual");
        setRepoVisibility(ROOT_GSV_MANUAL_REPO, "public", this.ctx.config);
      } else if (imported.changed) {
        this.ctx.config.set("repos/root/gsv-manual/updated_at", String(Date.now()));
      }
      this.storage.kv.put(STATE_KEY, {
        ...state, status: imported.diverged ? "diverged" : "current",
        head: imported.head ?? null,
      } satisfies ManualUpdateState);
      return { repo: "root/gsv-manual", remoteUrl: imported.remoteUrl,
        ref: imported.remoteRef, head: imported.head ?? null, changed: imported.changed };
    } catch (error) {
      this.storage.kv.put(STATE_KEY, { ...state, status: "failed" } satisfies ManualUpdateState);
      throw error;
    }
  }
}

function resolveManualUpstream(env: KernelContext["env"]) {
  const configuredUpstream = readEnvString(env, GSV_MANUAL_BOOTSTRAP_UPSTREAM_ENV);
  const configured = configuredUpstream ? parseConfiguredUpstream(configuredUpstream) : undefined;
  return {
    remoteUrl: configured?.remoteUrl ?? manualVersion.repository,
    ref: readEnvString(env, GSV_MANUAL_BOOTSTRAP_REF_ENV)
      ?? configured?.ref
      ?? (configured ? "main" : manualVersion.revision),
  };
}

function parseConfiguredUpstream(value: string): BootstrapUpstream {
  const split = splitUpstreamRef(value);
  return {
    remoteUrl: bootstrapUpstreamUrl(split.upstream),
    ref: split.ref,
  };
}

function splitUpstreamRef(value: string): BootstrapRefSplit {
  const hashIndex = value.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex === value.length - 1) {
    return { upstream: value };
  }
  const upstream = value.slice(0, hashIndex).trim();
  const ref = value.slice(hashIndex + 1).trim();
  if (!upstream || !ref) {
    return { upstream: value };
  }
  return { upstream, ref };
}

function bootstrapUpstreamUrl(value: string): string {
  if (looksLikeGitRemoteUrl(value)) {
    return value;
  }
  return githubRepoUrl(value);
}

function githubRepoUrl(repo: string): string {
  const trimmed = repo.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid bootstrap repo: ${repo}`);
  }
  return `https://github.com/${trimmed}`;
}

function readEnvString(env: KernelContext["env"], name: string): string | undefined {
  const value = Object.entries(env).find(([key]) => key === name)?.[1];
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function looksLikeGitRemoteUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || /^[^@]+@[^:]+:.+$/.test(value);
}
