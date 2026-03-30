import { getAgentByName } from "agents";
import { env, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AppFrameContext,
  KernelBindingProps,
  PackageBindingProps,
} from "../protocol/app-frame";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { ArgsOf, ResultOf, SyscallName } from "../syscalls";
import { BUILTIN_CHAT_WORKER_SOURCE } from "./builtin/chat";
import { BUILTIN_CONTROL_WORKER_SOURCE } from "./builtin/control";
import { BUILTIN_DEVICES_WORKER_SOURCE } from "./builtin/devices";
import { BUILTIN_DOCTOR_SOURCE } from "./builtin/doctor";
import { BUILTIN_FILES_WORKER_SOURCE } from "./builtin/files";
import {
  BUILTIN_PACKAGES_ICON_SOURCE,
  BUILTIN_PACKAGES_WORKER_SOURCE,
} from "./builtin/packages";
import { BUILTIN_PROCESSES_WORKER_SOURCE } from "./builtin/processes";
import { BUILTIN_SHELL_WORKER_SOURCE } from "./builtin/shell";

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

    const response = await kernel.appRequest(this.getAppFrame(), frame);
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

export const BUILTIN_PACKAGE_SEEDS: readonly PackageSeed[] = [
  createBuiltinChatAppPackage(),
  createBuiltinShellAppPackage(),
  createBuiltinDevicesAppPackage(),
  createBuiltinProcessesAppPackage(),
  createBuiltinFilesAppPackage(),
  createBuiltinControlAppPackage(),
  createBuiltinDoctorPackage(),
  createBuiltinPackagesAppPackage(),
] as const;

export const DEFAULT_PACKAGE_COMPATIBILITY_DATE = "2026-01-28";

export function packageRouteBase(packageName: string): string {
  return `/apps/${packageName}`;
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

  seedBuiltinPackages(now: number = Date.now()): InstalledPackageRecord[] {
    const installed: InstalledPackageRecord[] = [];
    const builtinPackageIds = new Set(BUILTIN_PACKAGE_SEEDS.map((seed) => seed.packageId));

    for (const record of this.list()) {
      if (record.packageId.startsWith("builtin:") && !builtinPackageIds.has(record.packageId)) {
        this.remove(record.packageId);
      }
    }

    for (const seed of BUILTIN_PACKAGE_SEEDS) {
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

function createBuiltinDoctorPackage(): PackageSeed {
  return {
    packageId: "builtin:doctor@0.1.0",
    manifest: {
      name: "doctor",
      description: "CLI doctor command scaffold for GSV status checks.",
      version: "0.1.0",
      runtime: "dynamic-worker",
      source: {
        repo: "gsv",
        ref: "main",
        subdir: "packages/doctor",
      },
      entrypoints: [
        {
          name: "doctor",
          kind: "command",
          command: "doctor",
          module: "/src/doctor.ts",
          exportName: "default",
          description: "Runs a basic GSV doctor check from the shell.",
        },
      ],
      capabilities: {
        egress: {
          mode: "none",
        },
      },
    },
    artifact: {
      hash: "builtin:doctor@0.1.0",
      mainModule: "/src/doctor.ts",
      modules: [
        {
          path: "/src/doctor.ts",
          kind: "esm",
          content: BUILTIN_DOCTOR_SOURCE,
        },
      ],
    },
    grants: {
      egress: {
        mode: "none",
      },
    },
    enabled: true,
  };
}

function createBuiltinPackagesAppPackage(): PackageSeed {
  return {
    packageId: "builtin:packages@0.1.0",
    manifest: {
      name: "packages",
      description: "Desktop package manager scaffold for browsing and installing packages.",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "gsv",
        ref: "main",
        subdir: "packages/packages",
      },
      entrypoints: [
        {
          name: "packages",
          kind: "ui",
          route: "/apps/packages",
          icon: {
            kind: "asset",
            module: "ui/packages-icon.svg",
          },
          syscalls: ["pkg.list"],
          windowDefaults: {
            width: 920,
            height: 620,
            minWidth: 700,
            minHeight: 460,
          },
          module: "ui/worker.ts",
          description: "Desktop app entrypoint for package browsing and installation.",
        },
      ],
      capabilities: {
        bindings: [
          {
            binding: "PACKAGE",
            kind: "package-state",
            interfaceName: "gsv.package.state.v1",
            required: true,
            description: "Stable package state surface backed by the package's own durable Package DO.",
          },
          {
            binding: "KERNEL",
            kind: "kernel",
            interfaceName: "gsv.kernel.app.v1",
            required: true,
            description: "Package-scoped req/res binding for kernel-native syscalls.",
          },
        ],
        egress: {
          mode: "none",
        },
      },
    },
    artifact: {
      hash: "builtin:packages@0.1.0",
      compatibilityDate: DEFAULT_PACKAGE_COMPATIBILITY_DATE,
      mainModule: "ui/worker.ts",
      modules: [
        {
          path: "ui/worker.ts",
          kind: "esm",
          content: BUILTIN_PACKAGES_WORKER_SOURCE,
        },
        {
          path: "ui/packages-icon.svg",
          kind: "text",
          content: BUILTIN_PACKAGES_ICON_SOURCE,
        },
      ],
    },
    grants: {
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
    },
    enabled: true,
  };
}

function createBuiltinEmbeddedUiPackage(input: {
  name: string;
  description: string;
  iconId: string;
  syscalls: string[];
  windowDefaults: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
  };
  workerSource: string;
}): PackageSeed {
  return {
    packageId: `builtin:${input.name}@0.1.0`,
    manifest: {
      name: input.name,
      description: input.description,
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "gsv",
        ref: "main",
        subdir: `packages/${input.name}`,
      },
      entrypoints: [
        {
          name: input.name,
          kind: "ui",
          route: packageRouteBase(input.name),
          icon: {
            kind: "builtin",
            id: input.iconId,
          },
          syscalls: input.syscalls,
          windowDefaults: input.windowDefaults,
          module: "ui/worker.ts",
          description: input.description,
        },
      ],
      capabilities: {
        egress: {
          mode: "none",
        },
      },
    },
    artifact: {
      hash: `builtin:${input.name}@0.1.0`,
      compatibilityDate: DEFAULT_PACKAGE_COMPATIBILITY_DATE,
      mainModule: "ui/worker.ts",
      modules: [
        {
          path: "ui/worker.ts",
          kind: "esm",
          content: input.workerSource,
        },
      ],
    },
    grants: {
      egress: {
        mode: "none",
      },
    },
    enabled: true,
  };
}

function createBuiltinChatAppPackage(): PackageSeed {
  return createBuiltinEmbeddedUiPackage({
    name: "chat",
    description: "Conversational workspace with agents.",
    iconId: "chat",
    syscalls: ["proc.spawn", "proc.send", "proc.history", "sys.workspace.list"],
    windowDefaults: {
      width: 880,
      height: 640,
      minWidth: 620,
      minHeight: 420,
    },
    workerSource: BUILTIN_CHAT_WORKER_SOURCE,
  });
}

function createBuiltinShellAppPackage(): PackageSeed {
  return createBuiltinEmbeddedUiPackage({
    name: "shell",
    description: "Interactive command shell for nodes.",
    iconId: "shell",
    syscalls: ["shell.exec", "sys.device.list"],
    windowDefaults: {
      width: 980,
      height: 640,
      minWidth: 700,
      minHeight: 420,
    },
    workerSource: BUILTIN_SHELL_WORKER_SOURCE,
  });
}

function createBuiltinDevicesAppPackage(): PackageSeed {
  return createBuiltinEmbeddedUiPackage({
    name: "devices",
    description: "Connected machine inventory and runtime device status.",
    iconId: "devices",
    syscalls: ["sys.device.list", "sys.device.get"],
    windowDefaults: {
      width: 940,
      height: 620,
      minWidth: 720,
      minHeight: 460,
    },
    workerSource: BUILTIN_DEVICES_WORKER_SOURCE,
  });
}

function createBuiltinProcessesAppPackage(): PackageSeed {
  return createBuiltinEmbeddedUiPackage({
    name: "processes",
    description: "Inspect and manage running agent processes.",
    iconId: "processes",
    syscalls: ["proc.list", "proc.kill"],
    windowDefaults: {
      width: 920,
      height: 620,
      minWidth: 700,
      minHeight: 440,
    },
    workerSource: BUILTIN_PROCESSES_WORKER_SOURCE,
  });
}

function createBuiltinFilesAppPackage(): PackageSeed {
  return createBuiltinEmbeddedUiPackage({
    name: "files",
    description: "File browser and workspace management.",
    iconId: "files",
    syscalls: ["fs.read", "fs.search", "fs.write", "fs.edit", "fs.delete", "sys.device.list"],
    windowDefaults: {
      width: 980,
      height: 650,
      minWidth: 720,
      minHeight: 460,
    },
    workerSource: BUILTIN_FILES_WORKER_SOURCE,
  });
}

function createBuiltinControlAppPackage(): PackageSeed {
  return createBuiltinEmbeddedUiPackage({
    name: "control",
    description: "System status, permissions, and settings.",
    iconId: "control",
    syscalls: [
      "sys.config.get",
      "sys.config.set",
      "sys.token.create",
      "sys.token.list",
      "sys.token.revoke",
      "sys.link",
      "sys.unlink",
      "sys.link.list",
      "sys.link.consume",
      "adapter.connect",
      "adapter.disconnect",
      "adapter.status",
    ],
    windowDefaults: {
      width: 860,
      height: 580,
      minWidth: 640,
      minHeight: 420,
    },
    workerSource: BUILTIN_CONTROL_WORKER_SOURCE,
  });
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
