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
 */

export type PackageRuntime = "dynamic-worker" | "node" | "web-ui";

export type PackageSourceKind =
  | "builtin"
  | "workspace"
  | "git"
  | "registry";

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

export type PackageBindingKind =
  | "kernel"
  | "fs"
  | "sql"
  | "alarm"
  | "service"
  | "custom";

export type PackageEgressMode = "none" | "inherit" | "allowlist";

export type PackageStateKind = "fs" | "actor" | "sql";

export type PackageStateScope =
  | "package"
  | "workspace"
  | "process"
  | "session";

export type PackageBindingProviderKind =
  | "kernel-entrypoint"
  | "workspace-fs"
  | "package-fs"
  | "sql-actor"
  | "service"
  | "custom";

export interface PackageSource {
  kind: PackageSourceKind;
  ref: string;
  revision?: string | null;
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
  tagName?: `${string}-${string}`;
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

/**
 * Declared state surface requested by the package.
 *
 * Example:
 * - binding: "SQLITE"
 * - kind: "sql"
 * - scope: "package"
 */
export interface PackageStateRequest {
  binding: string;
  kind: PackageStateKind;
  scope: PackageStateScope;
  description?: string;
}

export interface PackageCapabilityDeclaration {
  bindings?: PackageBindingRequest[];
  state?: PackageStateRequest[];
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

/**
 * Concrete state grant decided by kernel at install or launch time.
 */
export interface PackageStateGrant {
  binding: string;
  providerKind: "workspace-fs" | "package-fs" | "sql-actor" | "service" | "custom";
  providerRef: string;
  scopeKey?: string;
  config?: Record<string, string>;
}

export interface PackageGrantSet {
  bindings?: PackageBindingGrant[];
  state?: PackageStateGrant[];
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
  createBuiltinEchoPackage(),
  createBuiltinPackagesAppPackage(),
] as const;

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
        source_kind      TEXT    NOT NULL,
        source_ref       TEXT    NOT NULL,
        source_revision  TEXT,
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

    for (const seed of BUILTIN_PACKAGE_SEEDS) {
      const existing = this.get(seed.packageId);
      if (existing) {
        installed.push(existing);
        continue;
      }

      installed.push(this.install({
        ...seed,
        installedAt: now,
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
        (package_id, name, version, runtime, enabled, source_kind, source_ref, source_revision, manifest_json, artifact_json, grants_json, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.packageId,
      record.manifest.name,
      record.manifest.version,
      record.manifest.runtime,
      record.enabled ? 1 : 0,
      record.manifest.source.kind,
      record.manifest.source.ref,
      record.manifest.source.revision ?? null,
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

function createBuiltinEchoPackage(): PackageSeed {
  return {
    packageId: "builtin:echo@0.1.0",
    manifest: {
      name: "echo",
      description: "Minimal command package scaffold for shell-style entrypoints.",
      version: "0.1.0",
      runtime: "dynamic-worker",
      source: {
        kind: "builtin",
        ref: "builtin://packages/echo",
      },
      entrypoints: [
        {
          name: "echo",
          kind: "command",
          command: "echo",
          module: "/src/echo.ts",
          exportName: "default",
          description: "Returns the provided arguments as stdout.",
        },
      ],
      capabilities: {
        bindings: [
          {
            binding: "KERNEL",
            kind: "kernel",
            interfaceName: "gsv.kernel.command.v1",
            required: true,
            description: "Kernel command invocation surface.",
          },
        ],
        egress: {
          mode: "none",
        },
      },
    },
    artifact: {
      hash: "builtin:echo@0.1.0",
      mainModule: "/src/echo.ts",
      modules: [
        {
          path: "/src/echo.ts",
          kind: "esm",
          content: [
            "export default {",
            "  async run(input = {}) {",
            "    const args = Array.isArray(input.args) ? input.args : [];",
            "    return { ok: true, stdout: args.join(\" \") };",
            "  },",
            "};",
          ].join("\n"),
        },
      ],
    },
    grants: {
      bindings: [
        {
          binding: "KERNEL",
          providerKind: "kernel-entrypoint",
          providerRef: "kernel://commands/run",
        },
      ],
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
        kind: "builtin",
        ref: "builtin://packages/packages-app",
      },
      entrypoints: [
        {
          name: "packages",
          kind: "ui",
          route: "/apps/packages",
          tagName: "gsv-packages-app",
          module: "/ui/packages-app.ts",
          exportName: "registerPackagesApp",
          description: "Desktop app entrypoint for package browsing and installation.",
        },
      ],
      capabilities: {
        bindings: [
          {
            binding: "PACKAGES",
            kind: "kernel",
            interfaceName: "gsv.kernel.packages.v1",
            required: true,
            description: "Package listing and install operations.",
          },
        ],
        egress: {
          mode: "none",
        },
      },
    },
    artifact: {
      hash: "builtin:packages@0.1.0",
      mainModule: "/ui/packages-app.ts",
      modules: [
        {
          path: "/ui/packages-app.ts",
          kind: "esm",
          content: [
            "class GsvPackagesAppElement extends HTMLElement {",
            "  connectedCallback() {",
            "    this.innerHTML = \"<section><h1>Packages</h1><p>Package manager scaffold.</p></section>\";",
            "  }",
            "}",
            "",
            "export function registerPackagesApp() {",
            "  if (!customElements.get(\"gsv-packages-app\")) {",
            "    customElements.define(\"gsv-packages-app\", GsvPackagesAppElement);",
            "  }",
            "}",
          ].join("\n"),
        },
      ],
    },
    grants: {
      bindings: [
        {
          binding: "PACKAGES",
          providerKind: "kernel-entrypoint",
          providerRef: "kernel://packages/rpc",
        },
      ],
      egress: {
        mode: "none",
      },
    },
    enabled: true,
  };
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
