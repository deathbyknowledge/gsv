import { getAgentByName } from "agents";
import { env, WorkerEntrypoint } from "cloudflare:workers";
import type {
  PackageAssemblerInterface,
  PackageAssemblyAnalysis,
  PackageAssemblyResponse,
} from "@gsv/protocol/package-assembly";
import {
  RipgitClient,
  type RipgitPackageAnalyzeResponse,
  type RipgitPackageSnapshotResponse,
  type RipgitRepoRef,
} from "../fs/ripgit/client";
import type {
  AppFrameContext,
  KernelBindingProps,
} from "../protocol/app-frame";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { ArgsOf, ResultOf, SyscallName } from "../syscalls";

/**
 * Package model for GSV kernel-managed packages.
 *
 * Packages are modeled as:
 * - a manifest: identity + declared entrypoints + requested capabilities
 * - an artifact: the concrete code bundle for a target runtime
 * - install-time grants: the actual binding/state providers wired in by kernel
 *
 * This is designed to fit Cloudflare Dynamic Workers on the gateway side:
 * packages declare the bindings they expect, and the kernel decides which
 * concrete entrypoints or storage providers to expose at install/launch time.
 *
 * Important identity rule:
 * - worker/runtime identity is versioned by artifact hash
 * - package state identity is stable by package name + scope
 * - Package DO names must not include package version
 */

export type PackageRuntime = "dynamic-worker" | "node" | "web-ui";

type PackageAssemblerBinding = Fetcher & Pick<PackageAssemblerInterface, "assemblePackage">;
const BUILTIN_PACKAGE_ASSEMBLY_CONCURRENCY = 2;

export type PackageModuleKind =
  | "esm"
  | "commonjs"
  | "text"
  | "json"
  | "data";

export type PackageEntrypointKind =
  | "command"
  | "http"
  | "rpc"
  | "ui";

export type PackageInstallScope =
  | { kind: "global" }
  | { kind: "user"; uid: number }
  | { kind: "workspace"; workspaceId: string };

export type PackageIcon =
  | { kind: "builtin"; id: string }
  | { kind: "asset"; module: string };

export type PackageBindingKind =
  | "kernel"
  | "fs"
  | "service"
  | "custom";

export type PackageEgressMode = "none" | "inherit" | "allowlist";

export type PackageBindingProviderKind =
  | "kernel-entrypoint"
  | "workspace-fs"
  | "package-fs"
  | "service"
  | "custom";

export interface PackageSource {
  repo: string;
  ref: string;
  subdir: string;
  resolvedCommit?: string | null;
}

export interface PackageModuleDef {
  path: string;
  kind: PackageModuleKind;
  content: string;
}

export interface PackageArtifact {
  /**
   * Immutable artifact identity for cache keys / loader ids.
   * Prefer content-addressed values, e.g. "sha256:...".
   */
  hash: string;
  mainModule: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  modules: PackageModuleDef[];
}

export interface PackageEntrypoint {
  name: string;
  kind: PackageEntrypointKind;
  module: string;
  exportName?: string;
  description?: string;
  command?: string;
  route?: string;
  icon?: PackageIcon;
  syscalls?: string[];
  windowDefaults?: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
  };
}

export interface PackageProfileContextFile {
  name: string;
  text: string;
}

export interface PackageProfileManifest {
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  contextFiles: PackageProfileContextFile[];
  approvalPolicy?: string;
}

type KernelAppStub = {
  appRequest: (context: AppFrameContext, frame: RequestFrame) => Promise<ResponseFrame>;
};

export class KernelBinding extends WorkerEntrypoint<Env, KernelBindingProps> {
  private getAppFrame(): AppFrameContext {
    const appFrame = this.ctx.props.appFrame;
    if (!appFrame) {
      throw new Error("KernelBinding requires request-scoped appFrame props");
    }
    return appFrame;
  }

  async request<S extends SyscallName>(call: S, args: ArgsOf<S>): Promise<ResultOf<S>> {
    const kernel = await getAgentByName(this.env.KERNEL, "singleton") as unknown as KernelAppStub;
    const frame: RequestFrame<S> = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
    };

    const response = await kernel.appRequest(this.getAppFrame(), frame as RequestFrame);
    if (!response.ok) {
      throw new Error(response.error.message);
    }

    return response.data as ResultOf<S>;
  }
}

/**
 * Declared binding requested by the package.
 *
 * Example:
 * - binding: "KERNEL"
 * - kind: "kernel"
 * - interfaceName: "gsv.kernel.v1"
 */
export interface PackageBindingRequest {
  binding: string;
  kind: PackageBindingKind;
  interfaceName: string;
  required: boolean;
  description?: string;
}

export interface PackageCapabilityDeclaration {
  bindings?: PackageBindingRequest[];
  egress?: {
    mode: PackageEgressMode;
    allow?: string[];
  };
  tails?: string[];
}

export interface PackageManifest {
  name: string;
  description: string;
  version: string;
  runtime: PackageRuntime;
  source: PackageSource;
  entrypoints: PackageEntrypoint[];
  profiles?: PackageProfileManifest[];
  capabilities?: PackageCapabilityDeclaration;
}

type BuiltinRipgitPackageSpec = {
  source: PackageSource;
  grants?: PackageGrantSet;
  enabled: boolean;
};

/**
 * Concrete binding grant decided by kernel at install or launch time.
 */
export interface PackageBindingGrant {
  binding: string;
  providerKind: PackageBindingProviderKind;
  providerRef: string;
  config?: Record<string, string>;
}

export interface PackageGrantSet {
  bindings?: PackageBindingGrant[];
  egress?: {
    mode: PackageEgressMode;
    allow?: string[];
  };
}

export interface InstalledPackageRecord {
  packageId: string;
  scope: PackageInstallScope;
  manifest: PackageManifest;
  artifact: PackageArtifact;
  grants?: PackageGrantSet;
  enabled: boolean;
  reviewRequired: boolean;
  reviewedAt?: number | null;
  installedAt: number;
  updatedAt: number;
}

export type PackageSeed = Omit<InstalledPackageRecord, "installedAt" | "updatedAt">;



// TODO: remove all this crap with a prper runtime sdk and streamline this


export const DEFAULT_PACKAGE_COMPATIBILITY_DATE = "2026-01-28";
export const BUILTIN_SOURCE_OWNER = "system";
export const BUILTIN_SOURCE_REPO = "gsv";
export const BUILTIN_SOURCE_REF = "main";

const BUILTIN_RIPGIT_PACKAGE_SPECS: readonly BuiltinRipgitPackageSpec[] = [
  createBuiltinRipgitPackageSpec("chat"),
  createBuiltinRipgitPackageSpec("shell", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
  createBuiltinRipgitPackageSpec("devices", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
  createBuiltinRipgitPackageSpec("adapters", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
  createBuiltinRipgitPackageSpec("processes", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
  createBuiltinRipgitPackageSpec("files", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
  createBuiltinRipgitPackageSpec("wiki", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
  createBuiltinRipgitPackageSpec("control", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
  createBuiltinRipgitPackageSpec("ascii-starfield"),
  createBuiltinRipgitPackageSpec("doctor"),
  createBuiltinRipgitPackageSpec("packages", {
    bindings: [
      {
        binding: "KERNEL",
        providerKind: "kernel-entrypoint",
        providerRef: "kernel://app/request",
      },
    ],
    egress: {
      mode: "none",
    },
  }),
] as const;

const TEXT_DECODER = new TextDecoder();

export function packageRouteBase(packageName: string): string {
  return `/apps/${packageName}`;
}

function createBuiltinRipgitPackageSpec(
  name: string,
  grants: PackageGrantSet = {
    egress: {
      mode: "none",
    },
  },
): BuiltinRipgitPackageSpec {
  return {
    source: {
      repo: `${BUILTIN_SOURCE_OWNER}/${BUILTIN_SOURCE_REPO}`,
      ref: BUILTIN_SOURCE_REF,
      subdir: `builtin-packages/${name}`,
    },
    grants,
    enabled: true,
  };
}

type PackageScopeOwner = { uid: number } | null | undefined;

export function packageScopeKey(scope: PackageInstallScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "user":
      return `user:${scope.uid}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
  }
}

export function defaultPackageInstallScopeForActor(
  actor: PackageScopeOwner,
): PackageInstallScope {
  if (actor && actor.uid !== 0) {
    return { kind: "user", uid: actor.uid };
  }
  return { kind: "global" };
}

export function visiblePackageScopesForActor(
  actor: PackageScopeOwner,
): PackageInstallScope[] {
  const scopes: PackageInstallScope[] = [];
  if (actor && actor.uid !== 0) {
    scopes.push({ kind: "user", uid: actor.uid });
  }
  scopes.push({ kind: "global" });
  return scopes;
}

export function packageScopeEquals(
  left: PackageInstallScope,
  right: PackageInstallScope,
): boolean {
  return packageScopeKey(left) === packageScopeKey(right);
}

/**
 * Versioned worker/runtime key.
 *
 * Unlike Package DO identity, this is expected to change when code changes.
 */
export function packageWorkerKey(record: {
  manifest: { name: string };
  artifact: { hash: string };
}): string {
  return `pkg:${record.manifest.name}@${record.artifact.hash}`;
}

export function resolvePackageProfileReference(
  reference: string,
  packages: PackageStore,
  scopes: PackageInstallScope[],
): { record: InstalledPackageRecord; packageProfile: PackageProfileManifest } | null {
  const trimmed = typeof reference === "string" ? reference.trim() : "";
  const separator = trimmed.lastIndexOf("#");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    return null;
  }

  const packageRef = trimmed.slice(0, separator).trim();
  const profileName = trimmed.slice(separator + 1).trim();
  if (!packageRef || !profileName) {
    return null;
  }

  const exact = packages.resolve(packageRef, scopes);
  if (exact) {
    const packageProfile = exact.manifest.profiles?.find((entry) => entry.name === profileName);
    return packageProfile ? { record: exact, packageProfile } : null;
  }

  const candidates = packages.list({ scopes }).filter((candidate) =>
    matchesPackageReference(candidate, packageRef) &&
    (candidate.manifest.profiles ?? []).some((entry) => entry.name === profileName)
  );

  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    throw new Error(`Ambiguous package profile reference: ${reference}`);
  }

  const record = candidates[0];
  const packageProfile = record.manifest.profiles?.find((entry) => entry.name === profileName);
  return packageProfile ? { record, packageProfile } : null;
}

export function packageArtifactToWorkerCode(
  artifact: PackageArtifact,
  env?: Record<string, unknown>,
): WorkerLoaderWorkerCode {
  const modules: Record<string, WorkerLoaderModule | string> = {};

  for (const module of artifact.modules) {
    switch (module.kind) {
      case "esm":
        modules[module.path] = { js: module.content };
        break;
      case "commonjs":
        modules[module.path] = { cjs: module.content };
        break;
      case "text":
        modules[module.path] = { text: module.content };
        break;
      case "json":
        modules[module.path] = { json: JSON.parse(module.content) };
        break;
      case "data":
        modules[module.path] = {
          data: Uint8Array.from(atob(module.content), (char) => char.charCodeAt(0)).buffer,
        };
        break;
      default:
        throw new Error(`Unsupported package module kind: ${(module as { kind: string }).kind}`);
    }
  }

  return {
    compatibilityDate: artifact.compatibilityDate ?? DEFAULT_PACKAGE_COMPATIBILITY_DATE,
    compatibilityFlags: artifact.compatibilityFlags,
    mainModule: artifact.mainModule,
    modules,
    env,
  };
}

export class PackageStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS packages (
        package_id       TEXT    NOT NULL,
        scope_key        TEXT    NOT NULL,
        scope_kind       TEXT    NOT NULL,
        scope_uid        INTEGER,
        scope_workspace_id TEXT,
        name             TEXT    NOT NULL,
        version          TEXT    NOT NULL,
        runtime          TEXT    NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 1,
        manifest_json    TEXT    NOT NULL,
        artifact_json    TEXT    NOT NULL,
        grants_json      TEXT,
        installed_at     INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        review_required  INTEGER NOT NULL DEFAULT 0,
        reviewed_at      INTEGER,
        UNIQUE(package_id, scope_key)
      )
    `);

    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_packages_name_runtime ON packages (name, runtime, updated_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_packages_enabled ON packages (enabled, name, updated_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_packages_scope_name_runtime ON packages (scope_key, name, runtime, updated_at DESC)",
    );
  }

  seedBuiltinPackages(
    builtinSeeds: readonly PackageSeed[],
    now: number = Date.now(),
  ): InstalledPackageRecord[] {
    const installed: InstalledPackageRecord[] = [];
    const builtinPackageIds = new Set(builtinSeeds.map((seed) => seed.packageId));

    for (const record of this.list({ scope: { kind: "global" } })) {
      if (record.packageId.startsWith("builtin:") && !builtinPackageIds.has(record.packageId)) {
        this.remove(record.packageId, record.scope);
      }
    }

    for (const seed of builtinSeeds) {
      const existing = this.get(seed.packageId, seed.scope);
      installed.push(this.install({
        ...seed,
        enabled: existing?.enabled ?? seed.enabled,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      }));
    }

    return installed;
  }

  install(
    input: Omit<InstalledPackageRecord, "installedAt" | "updatedAt"> & {
      installedAt?: number;
      updatedAt?: number;
    },
  ): InstalledPackageRecord {
    const now = Date.now();
    const record: InstalledPackageRecord = {
      ...input,
      installedAt: input.installedAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };

    assertValidPackageRecord(record);

    this.sql.exec(
      `INSERT OR REPLACE INTO packages
        (package_id, scope_key, scope_kind, scope_uid, scope_workspace_id, name, version, runtime, enabled, manifest_json, artifact_json, grants_json, installed_at, updated_at, review_required, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.packageId,
      packageScopeKey(record.scope),
      record.scope.kind,
      record.scope.kind === "user" ? record.scope.uid : null,
      record.scope.kind === "workspace" ? record.scope.workspaceId : null,
      record.manifest.name,
      record.manifest.version,
      record.manifest.runtime,
      record.enabled ? 1 : 0,
      JSON.stringify(record.manifest),
      JSON.stringify(record.artifact),
      record.grants ? JSON.stringify(record.grants) : null,
      record.installedAt,
      record.updatedAt,
      record.reviewRequired ? 1 : 0,
      record.reviewedAt ?? null,
    );

    return record;
  }

  get(
    packageId: string,
    scope: PackageInstallScope,
  ): InstalledPackageRecord | null {
    const rows = this.sql.exec<RowShape>(
      "SELECT * FROM packages WHERE package_id = ? AND scope_key = ?",
      packageId,
      packageScopeKey(scope),
    ).toArray();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  resolve(
    packageId: string,
    scopes: readonly PackageInstallScope[],
  ): InstalledPackageRecord | null {
    for (const scope of scopes) {
      const record = this.get(packageId, scope);
      if (record) {
        return record;
      }
    }
    return null;
  }

  list(opts?: {
    enabled?: boolean;
    runtime?: PackageRuntime;
    name?: string;
    scope?: PackageInstallScope;
    scopes?: readonly PackageInstallScope[];
  }): InstalledPackageRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const scopes = opts?.scopes ?? (opts?.scope ? [opts.scope] : undefined);

    if (typeof opts?.enabled === "boolean") {
      where.push("enabled = ?");
      params.push(opts.enabled ? 1 : 0);
    }
    if (opts?.runtime) {
      where.push("runtime = ?");
      params.push(opts.runtime);
    }
    if (opts?.name) {
      where.push("name = ?");
      params.push(opts.name);
    }
    if (scopes && scopes.length === 1) {
      where.push("scope_key = ?");
      params.push(packageScopeKey(scopes[0]));
    } else if (scopes && scopes.length > 1) {
      where.push(`scope_key IN (${scopes.map(() => "?").join(", ")})`);
      for (const scope of scopes) {
        params.push(packageScopeKey(scope));
      }
    }

    const sql = where.length > 0
      ? `SELECT * FROM packages WHERE ${where.join(" AND ")} ORDER BY name, version, updated_at DESC`
      : "SELECT * FROM packages ORDER BY name, version, updated_at DESC";

    const records = this.sql.exec<RowShape>(sql, ...params).toArray().map(toRecord);
    if (scopes && scopes.length > 1) {
      const order = new Map(scopes.map((scope, index) => [packageScopeKey(scope), index]));
      records.sort((left, right) => {
        const leftOrder = order.get(packageScopeKey(left.scope)) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = order.get(packageScopeKey(right.scope)) ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        const nameOrder = left.manifest.name.localeCompare(right.manifest.name);
        if (nameOrder !== 0) {
          return nameOrder;
        }
        if (left.updatedAt !== right.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.packageId.localeCompare(right.packageId);
      });
    }
    return records;
  }

  setEnabled(packageId: string, enabled: boolean, scope: PackageInstallScope): boolean {
    const existing = this.get(packageId, scope);
    if (!existing) return false;

    this.sql.exec(
      "UPDATE packages SET enabled = ?, updated_at = ? WHERE package_id = ? AND scope_key = ?",
      enabled ? 1 : 0,
      Date.now(),
      packageId,
      packageScopeKey(scope),
    );

    return true;
  }

  setReviewed(packageId: string, reviewedAt: number | null, scope: PackageInstallScope): boolean {
    const existing = this.get(packageId, scope);
    if (!existing) return false;

    this.sql.exec(
      "UPDATE packages SET reviewed_at = ?, updated_at = ? WHERE package_id = ? AND scope_key = ?",
      reviewedAt,
      Date.now(),
      packageId,
      packageScopeKey(scope),
    );

    return true;
  }

  remove(packageId: string, scope: PackageInstallScope): boolean {
    const existing = this.get(packageId, scope);
    if (!existing) return false;

    this.sql.exec(
      "DELETE FROM packages WHERE package_id = ? AND scope_key = ?",
      packageId,
      packageScopeKey(scope),
    );
    return true;
  }
}

type RowShape = {
  package_id: string;
  scope_key: string;
  scope_kind: string;
  scope_uid: number | null;
  scope_workspace_id: string | null;
  manifest_json: string;
  artifact_json: string;
  grants_json: string | null;
  enabled: number;
  installed_at: number;
  updated_at: number;
  review_required: number | null;
  reviewed_at: number | null;
};

function toRecord(row: RowShape): InstalledPackageRecord {
  return {
    packageId: row.package_id,
    scope: scopeFromRow(row),
    manifest: parseJson<PackageManifest>(row.manifest_json),
    artifact: parseJson<PackageArtifact>(row.artifact_json),
    grants: row.grants_json ? parseJson<PackageGrantSet>(row.grants_json) : undefined,
    enabled: row.enabled !== 0,
    reviewRequired: row.review_required !== 0,
    reviewedAt: row.reviewed_at ?? null,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

function scopeFromRow(row: Pick<RowShape, "scope_kind" | "scope_uid" | "scope_workspace_id">): PackageInstallScope {
  switch (row.scope_kind) {
    case "user":
      if (typeof row.scope_uid !== "number") {
        throw new Error("Invalid package row: user scope missing uid");
      }
      return { kind: "user", uid: row.scope_uid };
    case "workspace":
      if (!row.scope_workspace_id) {
        throw new Error("Invalid package row: workspace scope missing workspace id");
      }
      return { kind: "workspace", workspaceId: row.scope_workspace_id };
    default:
      return { kind: "global" };
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export async function buildBuiltinPackageSeeds(
  env: Env,
): Promise<PackageSeed[]> {
  const ripgitBinding = env.RIPGIT;
  if (!ripgitBinding) {
    throw new Error("RIPGIT binding is required for builtin package resolution");
  }
  if (!env.ASSEMBLER) {
    throw new Error("ASSEMBLER binding is required for builtin package resolution");
  }

  const ripgit = new RipgitClient(ripgitBinding);
  const ripgitSeeds = await mapWithConcurrency(
    BUILTIN_RIPGIT_PACKAGE_SPECS,
    BUILTIN_PACKAGE_ASSEMBLY_CONCURRENCY,
    (spec) => resolveBuiltinRipgitPackage(env, ripgit, spec),
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to resolve builtin packages from ripgit. Push the gsv monorepo to system/gsv first. ${message}`,
    );
  });

  return ripgitSeeds;
}

export async function resolvePackageFromRipgitSource(
  env: Env,
  source: PackageSource,
): Promise<{ manifest: PackageManifest; artifact: PackageArtifact }> {
  const ripgitBinding = env.RIPGIT;
  if (!ripgitBinding) {
    throw new Error("RIPGIT binding is required for package source resolution");
  }

  const ripgit = new RipgitClient(ripgitBinding);
  return resolvePackageFromRipgitNativeBuild(env, ripgit, source);
}

async function resolvePackageFromRipgitNativeBuild(
  env: Env,
  ripgit: RipgitClient,
  source: PackageSource,
): Promise<{ manifest: PackageManifest; artifact: PackageArtifact }> {
  const assembler = requirePackageAssembler(env);
  const repo = parseRipgitRepoRef(source);
  const subdir = normalizePackageSourceSubdir(source.subdir);
  const analysis = await ripgit.analyzePackage(repo, subdir);

  if (!analysis.ok || !analysis.definition) {
    throw new Error(formatRipgitPackageFailure("package analysis failed", analysis.diagnostics));
  }
  const resolvedRepo = {
    ...repo,
    branch: analysis.source.resolved_commit,
  };
  const snapshot = await ripgit.snapshotPackage(resolvedRepo, subdir);
  assertSnapshotMatchesAnalysis(analysis, snapshot);
  const build = await assembler.assemblePackage({
    analysis: analysis as PackageAssemblyAnalysis,
    target: "dynamic-worker",
    files: snapshot.files,
  });

  assertAssemblySucceeded(build);

  const packageName = packageNameFromPackageJsonName(analysis.package_json.name);
  const kernelSyscalls = uniqueStrings(analysis.definition.meta.capabilities.kernel);
  const outboundAllowlist = uniqueStrings(analysis.definition.meta.capabilities.outbound);
  const routeBase = packageRouteBase(packageName);
  const artifact = convertAssembledArtifact(build);
  const icon = toNativePackageIcon(analysis.definition.meta.icon);
  const profiles = await readPackageProfiles(ripgit, resolvedRepo, subdir);

  const entrypoints: PackageEntrypoint[] = [
    ...analysis.definition.commands.map((command) => ({
      name: command.name,
      kind: "command" as const,
      module: artifact.mainModule,
      exportName: "GsvCommandEntrypoint",
      command: command.name,
      description: analysis.definition?.meta.description ?? undefined,
    })),
    ...(analysis.definition.app ? [{
      name: analysis.definition.meta.display_name,
      kind: "ui" as const,
      module: artifact.mainModule,
      route: routeBase,
      icon,
      syscalls: kernelSyscalls,
      windowDefaults: analysis.definition.meta.window
        ? {
            width: analysis.definition.meta.window.width ?? 1040,
            height: analysis.definition.meta.window.height ?? 720,
            minWidth: analysis.definition.meta.window.min_width ?? 760,
            minHeight: analysis.definition.meta.window.min_height ?? 520,
          }
        : undefined,
    }] : []),
    ...(analysis.definition.app?.has_rpc ? [{
      name: `${analysis.definition.meta.display_name} RPC`,
      kind: "rpc" as const,
      module: artifact.mainModule,
      exportName: "GsvAppRpcEntrypoint",
      description: analysis.definition?.meta.description ?? undefined,
    }] : []),
  ];

  return {
    manifest: {
      name: packageName,
      description: analysis.definition.meta.description ?? "",
      version: analysis.package_json.version?.trim() || "0.0.0",
      runtime: analysis.definition.app ? "web-ui" : "dynamic-worker",
      source: {
        repo: source.repo,
        ref: source.ref,
        subdir: normalizePackageSourceSubdir(build.source.subdir),
        resolvedCommit: build.source.resolved_commit,
      },
      entrypoints,
      ...(profiles.length > 0 ? { profiles } : {}),
      capabilities: {
        bindings: [
          ...(kernelSyscalls.length > 0 ? [{
            binding: "KERNEL",
            kind: "kernel" as const,
            interfaceName: "gsv.kernel.v1",
            required: true,
          }] : []),
        ],
        egress: outboundAllowlist.length > 0
          ? {
              mode: "allowlist",
              allow: outboundAllowlist,
            }
          : {
              mode: "none",
            },
      },
    },
    artifact,
  };
}

async function resolveBuiltinRipgitPackage(
  env: Env,
  client: RipgitClient,
  spec: BuiltinRipgitPackageSpec,
): Promise<PackageSeed> {
  const { manifest, artifact } = await resolvePackageFromRipgitNativeBuild(env, client, spec.source);

  return {
    packageId: `builtin:${manifest.name}@${manifest.version}`,
    scope: { kind: "global" },
    manifest,
    artifact,
    grants: spec.grants,
    enabled: spec.enabled,
    reviewRequired: false,
    reviewedAt: Date.now(),
  };
}

function parseRipgitRepoRef(source: Pick<PackageSource, "repo" | "ref">): {
  owner: string;
  repo: string;
  branch: string;
} {
  const [owner, repo] = source.repo.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`package source repo must be '<owner>/<repo>', got '${source.repo}'`);
  }
  return {
    owner,
    repo,
    branch: source.ref,
  };
}

function convertAssembledArtifact(
  build: PackageAssemblyResponse,
): PackageArtifact {
  if (!build.artifact) {
    throw new Error("package assembly artifact is missing");
  }

  return {
    hash: build.artifact.hash,
    mainModule: build.artifact.main_module,
    compatibilityDate: DEFAULT_PACKAGE_COMPATIBILITY_DATE,
    modules: build.artifact.modules.map((module) => ({
      path: module.path,
      kind: module.kind === "source-module" ? "esm" : module.kind,
      content: module.content,
    })),
  };
}

function requirePackageAssembler(env: Env): PackageAssemblerBinding {
  const binding = env.ASSEMBLER as (Fetcher & Partial<PackageAssemblerInterface>) | undefined;
  if (!binding || typeof binding.assemblePackage !== "function") {
    throw new Error("ASSEMBLER binding is required for package assembly");
  }
  return binding as PackageAssemblerBinding;
}

function assertAssemblySucceeded(build: PackageAssemblyResponse): asserts build is PackageAssemblyResponse & {
  artifact: NonNullable<PackageAssemblyResponse["artifact"]>;
} {
  if (!build.ok || !build.artifact) {
    throw new Error(formatRipgitPackageFailure("package assembly failed", build.diagnostics));
  }
}

function assertSnapshotMatchesAnalysis(
  analysis: RipgitPackageAnalyzeResponse,
  snapshot: RipgitPackageSnapshotResponse,
): void {
  if (snapshot.source.resolved_commit !== analysis.source.resolved_commit) {
    throw new Error(
      `package snapshot commit mismatch: analysis=${analysis.source.resolved_commit} snapshot=${snapshot.source.resolved_commit}`,
    );
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function packageNameFromPackageJsonName(packageJsonName: string): string {
  const trimmed = packageJsonName.trim();
  const candidate = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`Unable to derive package name from package.json name: ${packageJsonName}`);
  }
  return normalized;
}

async function readPackageProfiles(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  subdir: string,
): Promise<PackageProfileManifest[]> {
  const profilesRoot = joinRipgitPath(subdir, "profiles");
  const profilesTree = await ripgit.readPath(repo, profilesRoot);
  if (profilesTree.kind !== "tree") {
    return [];
  }

  const entries = profilesTree.entries
    .filter((entry) => entry.type === "tree")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const profiles: PackageProfileManifest[] = [];
  for (const name of entries) {
    const profileRoot = joinRipgitPath(profilesRoot, name);
    const contextRoot = joinRipgitPath(profileRoot, "context.d");
    const contextTree = await ripgit.readPath(repo, contextRoot);
    if (contextTree.kind !== "tree") {
      continue;
    }

    const contextFiles: PackageProfileContextFile[] = [];
    for (const entry of contextTree.entries
      .filter((item) => item.type === "blob")
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const file = await ripgit.readPath(repo, joinRipgitPath(contextRoot, entry.name));
      if (file.kind !== "file") {
        continue;
      }
      const text = decodeProfileTextFile(file.bytes);
      if (!text) {
        continue;
      }
      contextFiles.push({
        name: entry.name,
        text,
      });
    }

    if (contextFiles.length === 0) {
      continue;
    }

    const description = await readPackageProfileDescription(ripgit, repo, profileRoot);
    const approvalPolicy = await readPackageProfileApprovalPolicy(ripgit, repo, profileRoot);
    const icon = await readPackageProfileIconPath(ripgit, repo, profileRoot);
    profiles.push({
      name,
      displayName: humanizeProfileName(name),
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      contextFiles,
      ...(approvalPolicy ? { approvalPolicy } : {}),
    });
  }

  return profiles;
}

async function readPackageProfileDescription(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  profileRoot: string,
): Promise<string | null> {
  const descriptionFile = await ripgit.readPath(repo, joinRipgitPath(profileRoot, "description.md"));
  if (descriptionFile.kind !== "file") {
    return null;
  }
  return decodeProfileTextFile(descriptionFile.bytes);
}

async function readPackageProfileApprovalPolicy(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  profileRoot: string,
): Promise<string | null> {
  const approvalFile = await ripgit.readPath(repo, joinRipgitPath(profileRoot, "approval.json"));
  if (approvalFile.kind !== "file") {
    return null;
  }
  try {
    const decoded = TEXT_DECODER.decode(approvalFile.bytes);
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

async function readPackageProfileIconPath(
  ripgit: RipgitClient,
  repo: RipgitRepoRef,
  profileRoot: string,
): Promise<string | null> {
  const profileTree = await ripgit.readPath(repo, profileRoot);
  if (profileTree.kind !== "tree") {
    return null;
  }

  const iconEntry = profileTree.entries
    .filter((entry) => entry.type === "blob" && /^icon\.[^.]+$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .at(0);

  return iconEntry ? joinRipgitPath(profileRoot, iconEntry.name) : null;
}

function toNativePackageIcon(iconPath?: string | null): PackageIcon | undefined {
  if (!iconPath) {
    return undefined;
  }
  return {
    kind: "asset",
    module: normalizePackageModulePath(iconPath.replace(/^(\.\/)+/, "")),
  };
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function formatRipgitPackageFailure(
  prefix: string,
  diagnostics: RipgitPackageAnalyzeResponse["diagnostics"],
): string {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return prefix;
  }
  return `${prefix}: ${diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join("; ")}`;
}

function normalizePackageModulePath(path: string): string {
  return trimLeadingSlash(path);
}

function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function humanizeProfileName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function matchesPackageReference(
  record: InstalledPackageRecord,
  reference: string,
): boolean {
  const sourceRepo = record.manifest.source.repo;
  const normalizedSubdir = normalizePackageSourceSubdir(record.manifest.source.subdir) || ".";
  const importRepoAlias = `import:${sourceRepo}`;
  const importPathAlias = `import:${sourceRepo}:${normalizedSubdir}`;
  return record.packageId === reference
    || record.manifest.name === reference
    || sourceRepo === reference
    || importRepoAlias === reference
    || importPathAlias === reference;
}

function decodeProfileTextFile(bytes: Uint8Array): string | null {
  for (const byte of bytes) {
    if (byte === 0) {
      return null;
    }
  }
  const text = TEXT_DECODER.decode(bytes).trim();
  return text.length > 0 ? text : null;
}

function normalizePackageSourceSubdir(path: string): string {
  const normalized = trimSlashes(path.trim());
  return normalized.length === 0 || normalized === "." ? "." : normalized;
}

function joinRipgitPath(base: string, child: string): string {
  const normalizedBase = trimSlashes(base);
  const normalizedChild = trimSlashes(child);
  if (normalizedBase.length === 0) {
    return normalizedChild;
  }
  if (normalizedChild.length === 0) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedChild}`;
}

function assertValidPackageRecord(record: InstalledPackageRecord): void {
  if (record.packageId.trim().length === 0) {
    throw new Error("packageId is required");
  }
  if (packageScopeKey(record.scope).trim().length === 0) {
    throw new Error("scope is required");
  }
  if (record.manifest.name.trim().length === 0) {
    throw new Error("manifest.name is required");
  }
  if (record.manifest.version.trim().length === 0) {
    throw new Error("manifest.version is required");
  }
  if (record.manifest.entrypoints.length === 0 && (record.manifest.profiles?.length ?? 0) === 0) {
    throw new Error("manifest must contain at least one entrypoint or profile");
  }
  if (record.artifact.hash.trim().length === 0) {
    throw new Error("artifact.hash is required");
  }
  if (record.artifact.mainModule.trim().length === 0) {
    throw new Error("artifact.mainModule is required");
  }
  if (record.artifact.modules.length === 0) {
    throw new Error("artifact.modules must contain at least one module");
  }

  const modulePaths = new Set(record.artifact.modules.map((module) => module.path));
  if (!modulePaths.has(record.artifact.mainModule)) {
    throw new Error(`artifact.mainModule not found in modules: ${record.artifact.mainModule}`);
  }

  for (const entrypoint of record.manifest.entrypoints) {
    if (!modulePaths.has(entrypoint.module)) {
      throw new Error(`entrypoint module not found in artifact: ${entrypoint.module}`);
    }
    if (entrypoint.icon?.kind === "asset" && !modulePaths.has(entrypoint.icon.module)) {
      throw new Error(`entrypoint icon module not found in artifact: ${entrypoint.icon.module}`);
    }
    if (entrypoint.kind === "ui") {
      const expectedPrefix = packageRouteBase(record.manifest.name);
      if (!entrypoint.route || !entrypoint.route.startsWith(expectedPrefix)) {
        throw new Error(`ui entrypoint route must live under ${expectedPrefix}`);
      }
    }
  }

  for (const profile of record.manifest.profiles ?? []) {
    if (profile.name.trim().length === 0) {
      throw new Error("manifest.profiles[].name is required");
    }
    if (profile.contextFiles.length === 0) {
      throw new Error(`manifest profile ${profile.name} must contain at least one context file`);
    }
  }

  if (record.manifest.source.repo.trim().length === 0) {
    throw new Error("manifest.source.repo is required");
  }
  if (record.manifest.source.ref.trim().length === 0) {
    throw new Error("manifest.source.ref is required");
  }
  if (record.manifest.source.subdir.trim().length === 0) {
    throw new Error("manifest.source.subdir is required");
  }

  const egress = record.manifest.capabilities?.egress;
  if (egress?.mode !== "allowlist" && egress?.allow && egress.allow.length > 0) {
    throw new Error("capabilities.egress.allow is only valid when mode is 'allowlist'");
  }

  const grantedEgress = record.grants?.egress;
  if (
    grantedEgress?.mode !== "allowlist" &&
    grantedEgress?.allow &&
    grantedEgress.allow.length > 0
  ) {
    throw new Error("grants.egress.allow is only valid when mode is 'allowlist'");
  }
}
