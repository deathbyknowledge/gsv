import { getAgentByName } from "agents";
import { env, WorkerEntrypoint } from "cloudflare:workers";
import {
  RipgitClient,
  type RipgitPackageAnalyzeResponse,
  type RipgitPackageBuildResponse,
} from "../fs/ripgit/client";
import type {
  AppFrameContext,
  KernelBindingProps,
  PackageBindingProps,
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
  | "task"
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
  | "package-state"
  | "fs"
  | "service"
  | "custom";

export type PackageEgressMode = "none" | "inherit" | "allowlist";

export type PackageBindingProviderKind =
  | "kernel-entrypoint"
  | "package-do"
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

export type PackageSqlRow = Record<string, unknown>;

export interface PackageSqlExecResult {
  rowsWritten?: number;
}

export interface PackageSqlQueryResult {
  rows: PackageSqlRow[];
}

type PackageSqlStub = {
  sqlExec: (statement: string, params?: unknown[]) => Promise<PackageSqlExecResult>;
  sqlQuery: (statement: string, params?: unknown[]) => Promise<PackageSqlQueryResult>;
};

type KernelAppStub = {
  appRequest: (context: AppFrameContext, frame: RequestFrame) => Promise<ResponseFrame>;
};

export class PackageBinding extends WorkerEntrypoint<Env, PackageBindingProps> {
  private getPackageDoName(): string {
    const packageDoName = this.ctx.props.packageDoName?.trim();
    if (!packageDoName) {
      throw new Error("PackageBinding requires a stable packageDoName");
    }
    return packageDoName;
  }

  private getPackageStub(): PackageSqlStub {
    const namespace = (this.env as { PACKAGE_DO?: DurableObjectNamespace }).PACKAGE_DO;
    if (!namespace) {
      throw new Error("PackageBinding requires env.PACKAGE_DO");
    }
    return namespace.getByName(this.getPackageDoName()) as unknown as PackageSqlStub;
  }

  async sqlExec(statement: string, params: unknown[] = []): Promise<PackageSqlExecResult> {
    return this.getPackageStub().sqlExec(statement, params);
  }

  async sqlQuery(statement: string, params: unknown[] = []): Promise<PackageSqlQueryResult> {
    return this.getPackageStub().sqlQuery(statement, params);
  }
}

export class KernelBinding extends WorkerEntrypoint<Env, KernelBindingProps> {
  private getAppFrame(): AppFrameContext {
    const appFrame = this.ctx.props.appFrame;
    if (!appFrame) {
      throw new Error("KernelBinding requires request-scoped appFrame props");
    }
    return appFrame;
  }

  async request<S extends SyscallName>(call: S, args: ArgsOf<S>): Promise<ResultOf<S>> {
    const kernel = await getAgentByName(env.KERNEL, "singleton") as unknown as KernelAppStub;
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
  manifest: PackageManifest;
  artifact: PackageArtifact;
  grants?: PackageGrantSet;
  enabled: boolean;
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
        binding: "PACKAGE",
        providerKind: "package-do",
        providerRef: packageDoName("packages"),
      },
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
      subdir: `gateway/packages/${name}`,
    },
    grants,
    enabled: true,
  };
}

/**
 * Stable Package DO name.
 *
 * This must remain stable across version bumps so package-local SQLite state,
 * alarms, and durable state survive code upgrades.
 */
export function packageDoName(
  packageName: string,
  scope: PackageInstallScope = { kind: "global" },
): string {
  switch (scope.kind) {
    case "global":
      return `package:${packageName}`;
    case "user":
      return `package:${packageName}:user:${scope.uid}`;
    case "workspace":
      return `package:${packageName}:workspace:${scope.workspaceId}`;
  }
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
        package_id       TEXT PRIMARY KEY,
        name             TEXT    NOT NULL,
        version          TEXT    NOT NULL,
        runtime          TEXT    NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 1,
        manifest_json    TEXT    NOT NULL,
        artifact_json    TEXT    NOT NULL,
        grants_json      TEXT,
        installed_at     INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      )
    `);

    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_packages_name_runtime ON packages (name, runtime, updated_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_packages_enabled ON packages (enabled, name, updated_at DESC)",
    );
  }

  seedBuiltinPackages(
    builtinSeeds: readonly PackageSeed[],
    now: number = Date.now(),
  ): InstalledPackageRecord[] {
    const installed: InstalledPackageRecord[] = [];
    const builtinPackageIds = new Set(builtinSeeds.map((seed) => seed.packageId));

    for (const record of this.list()) {
      if (record.packageId.startsWith("builtin:") && !builtinPackageIds.has(record.packageId)) {
        this.remove(record.packageId);
      }
    }

    for (const seed of builtinSeeds) {
      const existing = this.get(seed.packageId);
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
        (package_id, name, version, runtime, enabled, manifest_json, artifact_json, grants_json, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.packageId,
      record.manifest.name,
      record.manifest.version,
      record.manifest.runtime,
      record.enabled ? 1 : 0,
      JSON.stringify(record.manifest),
      JSON.stringify(record.artifact),
      record.grants ? JSON.stringify(record.grants) : null,
      record.installedAt,
      record.updatedAt,
    );

    return record;
  }

  get(packageId: string): InstalledPackageRecord | null {
    const rows = this.sql.exec<RowShape>(
      "SELECT * FROM packages WHERE package_id = ?",
      packageId,
    ).toArray();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  list(opts?: {
    enabled?: boolean;
    runtime?: PackageRuntime;
    name?: string;
  }): InstalledPackageRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

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

    const sql = where.length > 0
      ? `SELECT * FROM packages WHERE ${where.join(" AND ")} ORDER BY name, version, updated_at DESC`
      : "SELECT * FROM packages ORDER BY name, version, updated_at DESC";

    return this.sql.exec<RowShape>(sql, ...params).toArray().map(toRecord);
  }

  setEnabled(packageId: string, enabled: boolean): boolean {
    const existing = this.get(packageId);
    if (!existing) return false;

    this.sql.exec(
      "UPDATE packages SET enabled = ?, updated_at = ? WHERE package_id = ?",
      enabled ? 1 : 0,
      Date.now(),
      packageId,
    );

    return true;
  }

  remove(packageId: string): boolean {
    const existing = this.get(packageId);
    if (!existing) return false;

    this.sql.exec(
      "DELETE FROM packages WHERE package_id = ?",
      packageId,
    );
    return true;
  }
}

type RowShape = {
  package_id: string;
  manifest_json: string;
  artifact_json: string;
  grants_json: string | null;
  enabled: number;
  installed_at: number;
  updated_at: number;
};

function toRecord(row: RowShape): InstalledPackageRecord {
  return {
    packageId: row.package_id,
    manifest: parseJson<PackageManifest>(row.manifest_json),
    artifact: parseJson<PackageArtifact>(row.artifact_json),
    grants: row.grants_json ? parseJson<PackageGrantSet>(row.grants_json) : undefined,
    enabled: row.enabled !== 0,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
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

  const ripgit = new RipgitClient(ripgitBinding, env.RIPGIT_INTERNAL_KEY ?? null);
  const ripgitSeeds = await Promise.all(
    BUILTIN_RIPGIT_PACKAGE_SPECS.map((spec) => resolveBuiltinRipgitPackage(ripgit, spec)),
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

  const ripgit = new RipgitClient(ripgitBinding, env.RIPGIT_INTERNAL_KEY ?? null);
  return resolvePackageFromRipgitNativeBuild(ripgit, source);
}

async function resolvePackageFromRipgitNativeBuild(
  ripgit: RipgitClient,
  source: PackageSource,
): Promise<{ manifest: PackageManifest; artifact: PackageArtifact }> {
  const repo = parseRipgitRepoRef(source);
  const subdir = normalizePackageSourceSubdir(source.subdir);
  const analysis = await ripgit.analyzePackage(repo, subdir);
  const build = await ripgit.buildPackage(repo, subdir, "dynamic-worker");

  if (!analysis.ok || !analysis.definition) {
    throw new Error(formatRipgitPackageFailure("package analysis failed", analysis.diagnostics));
  }
  if (!build.ok || !build.artifact) {
    throw new Error(formatRipgitPackageFailure("package build failed", build.diagnostics));
  }

  const packageName = packageNameFromPackageJsonName(analysis.package_json.name);
  const kernelSyscalls = uniqueStrings(analysis.definition.meta.capabilities.kernel);
  const outboundAllowlist = uniqueStrings(analysis.definition.meta.capabilities.outbound);
  const routeBase = packageRouteBase(packageName);
  const artifact = convertRipgitBuildArtifact(build);
  const icon = toNativePackageIcon(analysis.definition.meta.icon);

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
    ...analysis.definition.tasks.map((task) => ({
      name: task.name,
      kind: "task" as const,
      module: artifact.mainModule,
      exportName: "GsvTaskEntrypoint",
      description: analysis.definition?.meta.description ?? undefined,
    })),
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
      capabilities: {
        bindings: [
          {
            binding: "PACKAGE",
            kind: "package-state" as const,
            interfaceName: "gsv.package.v1",
            required: true,
          },
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
  client: RipgitClient,
  spec: BuiltinRipgitPackageSpec,
): Promise<PackageSeed> {
  const { manifest, artifact } = await resolvePackageFromRipgitNativeBuild(client, spec.source);

  return {
    packageId: `builtin:${manifest.name}@${manifest.version}`,
    manifest,
    artifact,
    grants: spec.grants,
    enabled: spec.enabled,
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

function convertRipgitBuildArtifact(
  build: RipgitPackageBuildResponse,
): PackageArtifact {
  if (!build.artifact) {
    throw new Error("ripgit build artifact is missing");
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

function packageNameFromPackageJsonName(packageJsonName: string): string {
  const trimmed = packageJsonName.trim();
  const candidate = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`Unable to derive package name from package.json name: ${packageJsonName}`);
  }
  return normalized;
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

function normalizePackageSourceRoot(path: string): string {
  const normalized = trimSlashes(path.trim());
  return normalized === "." ? "" : normalized;
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
  if (record.manifest.name.trim().length === 0) {
    throw new Error("manifest.name is required");
  }
  if (record.manifest.version.trim().length === 0) {
    throw new Error("manifest.version is required");
  }
  if (record.manifest.entrypoints.length === 0) {
    throw new Error("manifest.entrypoints must contain at least one entrypoint");
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
