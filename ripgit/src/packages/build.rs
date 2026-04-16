use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Cursor, Read};
use std::path::Path;

use base64::Engine;
use flate2::read::GzDecoder;
use oxc_allocator::Allocator;
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, Span};
use oxc_transformer::{JsxRuntime, TransformOptions, Transformer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use tar::Archive;
use worker::{Error, Fetch, Result, SqlStorage, SqlStorageValue};

use super::analyze::{analyze_package, analyze_package_source, PackageAnalysis};
use super::{
    resolve_source, PackageBuildTarget, PackageDiagnostic, PackageDiagnosticSeverity,
    PackageSourceLocator, ResolvedPackageSource,
};

const PACKAGE_BUILD_CACHE_VERSION: &str = "dynamic-worker-build-v3";
const PACKAGE_NPM_CACHE_VERSION: &str = "npm-lockfile-materialization-v2";
const GSV_PACKAGE_SDK_NAME: &str = "@gsv/package";
const GSV_PACKAGE_SDK_ROOT: &str = "__gsv_sdk/@gsv/package";
const GSV_PACKAGE_SDK_PACKAGE_JSON: &str = r#"{
  "name": "@gsv/package",
  "exports": {
    ".": "./src/index.ts",
    "./worker": "./src/worker.ts",
    "./host": "./src/host.ts",
    "./browser": "./src/browser.ts"
  }
}"#;
const GSV_PACKAGE_SDK_WORKER_TS: &str = r#"export function definePackage(definition) {
  return definition;
}
"#;
const GSV_PACKAGE_SDK_HOST_TS: &str = r#"export type HostStatus = {
  connected: boolean;
};

export type HostSignalHandler = (signal: string, payload: unknown) => void;
export type HostStatusHandler = (status: HostStatus) => void;

export type ThreadContext = {
  pid: string;
  workspaceId: string | null;
  cwd: string;
};

export type FilesOpenPayload = {
  device?: string;
  path?: string;
  open?: string;
  q?: string;
  context?: ThreadContext | null;
};

export type ShellOpenPayload = {
  device?: string;
  workdir?: string;
  context?: ThreadContext | null;
};

export type ChatOpenPayload = {
  pid: string;
  workspaceId?: string | null;
  cwd: string;
};

export type WikiOpenPayload = {
  db?: string;
  path?: string;
  mode?: "browse" | "edit" | "build" | "ingest" | "inbox";
};

export type OpenAppRequest =
  | { target: "files"; payload?: FilesOpenPayload }
  | { target: "shell"; payload?: ShellOpenPayload }
  | { target: "chat"; payload: ChatOpenPayload }
  | { target: "wiki"; payload?: WikiOpenPayload }
  | { target: string; payload?: { route?: string } };

export type HostClient = {
  getStatus(): HostStatus;
  onSignal(listener: HostSignalHandler): () => void;
  onStatus(listener: HostStatusHandler): () => void;
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
  spawnProcess(args: unknown): Promise<unknown>;
  sendMessage(message: string, pid?: string): Promise<unknown>;
  getHistory(limit: number, pid?: string, offset?: number): Promise<unknown>;
};

const OPEN_APP_EVENT = "gsv:open-app";
const PENDING_APP_OPEN_KEY = "__gsvPendingAppOpenRequests";

type PendingAppOpenStore = Map<string, OpenAppRequest>;

declare global {
  interface Window {
    [PENDING_APP_OPEN_KEY]?: PendingAppOpenStore;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeThreadContext(value: unknown): ThreadContext | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const pid = asString(record.pid)?.trim() || "";
  const cwd = asString(record.cwd)?.trim() || "";
  const workspaceId = asString(record.workspaceId)?.trim() || null;
  if (!pid || !cwd) {
    return null;
  }
  return { pid, cwd, workspaceId };
}

function writeParam(url: URL, key: string, value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    url.searchParams.set(key, normalized);
  } else {
    url.searchParams.delete(key);
  }
}

function buildFallbackRoute(request: OpenAppRequest): string {
  const target = String(request.target ?? "").trim();
  const payload = asRecord(request.payload) ?? {};
  if (target === "files") {
    const context = normalizeThreadContext(payload.context);
    const url = new URL("/apps/files", window.location.href);
    writeParam(url, "target", asString(payload.device) ?? undefined);
    writeParam(url, "path", asString(payload.path) ?? context?.cwd ?? undefined);
    writeParam(url, "open", asString(payload.open) ?? undefined);
    writeParam(url, "q", asString(payload.q) ?? undefined);
    return `${url.pathname}${url.search}`;
  }
  if (target === "shell") {
    const context = normalizeThreadContext(payload.context);
    const url = new URL("/apps/shell", window.location.href);
    writeParam(url, "target", asString(payload.device) ?? undefined);
    writeParam(url, "workdir", asString(payload.workdir) ?? context?.cwd ?? undefined);
    return `${url.pathname}${url.search}`;
  }
  if (target === "wiki") {
    const url = new URL("/apps/wiki", window.location.href);
    writeParam(url, "db", asString(payload.db) ?? undefined);
    writeParam(url, "path", asString(payload.path) ?? undefined);
    writeParam(url, "mode", asString(payload.mode) ?? undefined);
    return `${url.pathname}${url.search}`;
  }
  const explicitRoute = asString(payload.route)?.trim();
  if (explicitRoute) {
    return explicitRoute;
  }
  return `/apps/${encodeURIComponent(target)}`;
}

export function consumePendingAppOpen(windowId?: string): OpenAppRequest | null {
  const fallbackWindowId = new URL(window.location.href).searchParams.get("windowId")?.trim() || "";
  const normalizedWindowId = windowId?.trim() || fallbackWindowId;
  if (!normalizedWindowId) {
    return null;
  }

  try {
    const store = window.parent?.[PENDING_APP_OPEN_KEY];
    if (store instanceof Map) {
      const request = store.get(normalizedWindowId) ?? null;
      if (request) {
        store.delete(normalizedWindowId);
      }
      return request as OpenAppRequest | null;
    }
  } catch {
    // Ignore cross-window access failures outside the shell host.
  }

  return null;
}

export function openApp(request: OpenAppRequest): void {
  const detail = { request };
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: OPEN_APP_EVENT, detail }, window.location.origin);
      window.parent.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, { detail }));
      return;
    }
  } catch {
    // Fall back to same-window navigation outside the shell host.
  }
  window.location.href = buildFallbackRoute(request);
}

export async function connectHost(): Promise<HostClient> {
  throw new Error("HOST runtime is not wired in this build target");
}
"#;
const GSV_PACKAGE_SDK_BROWSER_TS: &str = r#"export type PackageAppBoot = {
  packageId: string;
  packageName: string;
  routeBase: string;
  rpcBase: string;
  sessionId: string;
  sessionSecret: string;
  clientId: string;
  expiresAt: number;
  hasBackend: boolean;
};

type CapnwebGlobal = {
  newWebSocketRpcSession<T = unknown>(url: string, localMain?: unknown): T;
};

type WrappedBackend = {
  invoke(method: string, args?: unknown): Promise<unknown>;
  dup?: () => unknown;
} & Record<string | symbol, unknown>;

declare global {
  interface Window {
    __GSV_APP_BOOT__?: PackageAppBoot;
    __GSV_BACKEND_READY__?: Promise<unknown>;
    backend?: unknown;
    capnweb?: CapnwebGlobal;
  }
}

export function getAppBoot(): PackageAppBoot {
  const boot = globalThis.window?.__GSV_APP_BOOT__;
  if (!boot) {
    throw new Error("GSV app bootstrap is unavailable");
  }
  return boot;
}

export function hasAppBoot(): boolean {
  return Boolean(globalThis.window?.__GSV_APP_BOOT__);
}

function getCapnweb(): CapnwebGlobal {
  const capnweb = globalThis.window?.capnweb;
  if (!capnweb || typeof capnweb.newWebSocketRpcSession !== "function") {
    throw new Error("capnweb runtime is unavailable");
  }
  return capnweb;
}

function wrapAppBackend<T = unknown>(backend: unknown): T {
  if (!backend || (typeof backend !== "object" && typeof backend !== "function")) {
    return backend as T;
  }
  const target = backend as WrappedBackend;
  if (typeof target.invoke !== "function") {
    return backend as T;
  }
  return new Proxy(target, {
    get(proxyTarget, prop) {
      if (prop === "then") {
        return undefined;
      }
      if (typeof prop !== "string") {
        return Reflect.get(proxyTarget, prop);
      }
      if (prop === "invoke" || prop === "dup") {
        const value = Reflect.get(proxyTarget, prop);
        return typeof value === "function" ? value.bind(proxyTarget) : value;
      }
      return (args?: unknown) => {
        return proxyTarget.invoke(prop, args);
      };
    },
  }) as T;
}

function buildRpcWebSocketUrl(rpcBase: string): string {
  const url = new URL(rpcBase, globalThis.window?.location?.href ?? "http://localhost");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function connectAppBackend<T = unknown>(): Promise<T> {
  const existing = globalThis.window?.__GSV_BACKEND_READY__;
  if (existing) {
    return existing as Promise<T>;
  }
  const boot = getAppBoot();
  if (!boot.hasBackend) {
    throw new Error("package app has no backend rpc");
  }
  const capnweb = getCapnweb();
  const ready = (async () => {
    const session = capnweb.newWebSocketRpcSession<{
      authenticate(secret: string): unknown;
    }>(buildRpcWebSocketUrl(boot.rpcBase));
    const backend = wrapAppBackend<T>(await session.authenticate(boot.sessionSecret));
    if (globalThis.window) {
      globalThis.window.backend = backend;
    }
    return backend;
  })();
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = ready;
  }
  return ready;
}

export async function getBackend<T = unknown>(): Promise<T> {
  return connectAppBackend<T>();
}
"#;
const GSV_PACKAGE_SDK_INDEX_TS: &str = r#"export * from "./worker";
export * from "./host";
export * from "./browser";
"#;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PackageArtifactModuleKind {
    SourceModule,
    Json,
    Text,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageArtifactModule {
    pub path: String,
    pub kind: PackageArtifactModuleKind,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageArtifact {
    pub main_module: String,
    pub modules: Vec<PackageArtifactModule>,
    pub hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageBuild {
    pub source: ResolvedPackageSource,
    pub analysis_hash: String,
    pub target: PackageBuildTarget,
    pub artifact: Option<PackageArtifact>,
    pub diagnostics: Vec<PackageDiagnostic>,
    pub ok: bool,
}

#[derive(Clone, Debug)]
struct RepoPackageManifest {
    root: String,
    manifest: PackageManifestInfo,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct PackageManifestInfo {
    name: Option<String>,
    main: Option<String>,
    module: Option<String>,
    exports: Option<Value>,
}

#[derive(Clone, Debug)]
struct ModuleJob {
    repo_path: String,
    output_path: String,
    origin: ModuleOrigin,
    target: ModuleTarget,
}

#[derive(Clone, Debug)]
enum ModuleOrigin {
    MainPackage {
        root: String,
    },
    Dependency {
        root: String,
        package_name: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModuleTarget {
    WorkerRuntime,
    BrowserAsset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicAssetKind {
    Html,
    JavaScript,
    Json,
    Css,
    Svg,
    Text,
}

#[derive(Clone, Debug)]
struct ResolvedImport {
    job: ModuleJob,
    rewritten_specifier: String,
}

#[derive(Clone, Debug, Deserialize)]
struct PackageLockfile {
    #[serde(default, rename = "lockfileVersion")]
    lockfile_version: Option<u32>,
    #[serde(default)]
    packages: BTreeMap<String, PackageLockfilePackageEntry>,
}

#[derive(Clone, Debug, Deserialize)]
struct PackageLockfilePackageEntry {
    resolved: Option<String>,
    integrity: Option<String>,
    #[serde(default)]
    link: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct BunLockfile {
    #[serde(default, rename = "lockfileVersion")]
    lockfile_version: Option<u32>,
    #[serde(default)]
    packages: BTreeMap<String, BunLockfilePackageEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
struct BunLockfilePackageEntry(Vec<Value>);

#[derive(Clone, Debug, PartialEq, Eq)]
struct MaterializedDependencyPlan {
    install_path: String,
    resolved_url: String,
    integrity: Option<String>,
    cache_key: String,
}

struct BundleBuilder<'a> {
    analysis: &'a PackageAnalysis,
    repo_files: &'a BTreeMap<String, String>,
    package_index: BTreeMap<String, RepoPackageManifest>,
    diagnostics: Vec<PackageDiagnostic>,
    emitted: BTreeMap<String, PackageArtifactModule>,
    queued_repo_paths: BTreeSet<String>,
    queue: VecDeque<ModuleJob>,
    public_assets: BTreeMap<String, PublicAssetKind>,
}

pub(crate) async fn build_package(
    sql: &SqlStorage,
    locator: &PackageSourceLocator,
    target: PackageBuildTarget,
) -> Result<PackageBuild> {
    let source = resolve_source(sql, locator)?;
    let build_cache_key = compute_build_cache_key(&source, target);
    if let Some(cached) = load_cached_build(sql, &build_cache_key)? {
        return Ok(cached);
    }

    let analysis = analyze_package(sql, locator)?;
    let mut repo_files = if analysis.ok {
        collect_repo_utf8_files_at_commit(sql, &analysis.source.resolved_commit)?
    } else {
        BTreeMap::new()
    };
    inject_builtin_sdk_files(&mut repo_files);
    if analysis.ok {
        materialize_lockfile_dependencies(sql, &analysis.source, &mut repo_files).await?;
    }
    let build = build_package_from_repo_files(&analysis, &repo_files, target)?;
    if build.ok {
        store_cached_build(sql, &build_cache_key, &build)?;
    }
    Ok(build)
}

pub(crate) fn build_package_source(
    analysis: &PackageAnalysis,
    files: BTreeMap<String, String>,
    target: PackageBuildTarget,
) -> Result<PackageBuild> {
    let repo_files = files
        .into_iter()
        .map(|(path, content)| {
            let repo_path = join_posix(&analysis.source.subdir, &path);
            (repo_path, content)
        })
        .collect::<BTreeMap<_, _>>();
    let mut repo_files = repo_files;
    inject_builtin_sdk_files(&mut repo_files);
    build_package_from_repo_files(analysis, &repo_files, target)
}

fn build_package_from_repo_files(
    analysis: &PackageAnalysis,
    repo_files: &BTreeMap<String, String>,
    target: PackageBuildTarget,
) -> Result<PackageBuild> {
    let mut diagnostics = analysis.diagnostics.clone();

    if !analysis.ok {
        return Ok(PackageBuild {
            source: analysis.source.clone(),
            analysis_hash: analysis.analysis_hash.clone(),
            target,
            artifact: None,
            diagnostics,
            ok: false,
        });
    }

    let package_index = index_repo_packages(repo_files, &analysis.source.subdir)?;
    let mut builder = BundleBuilder {
        analysis,
        repo_files,
        package_index,
        diagnostics,
        emitted: BTreeMap::new(),
        queued_repo_paths: BTreeSet::new(),
        queue: VecDeque::new(),
        public_assets: BTreeMap::new(),
    };

    builder.seed_main_package()?;
    builder.process_queue()?;

    diagnostics = builder.diagnostics;
    let ok = diagnostics
        .iter()
        .all(|diagnostic| diagnostic.severity != PackageDiagnosticSeverity::Error);

    let artifact = if ok {
        let main_module = "__gsv__/main.js".to_string();
        let bootstrap = generate_dynamic_worker_main_module(analysis, &builder.public_assets);
        builder.emitted.insert(
            main_module.clone(),
            PackageArtifactModule {
                path: main_module.clone(),
                kind: PackageArtifactModuleKind::SourceModule,
                content: bootstrap,
            },
        );
        let modules = builder.emitted.into_values().collect::<Vec<_>>();
        let hash = compute_artifact_hash(
            &analysis.source,
            &analysis.analysis_hash,
            target,
            &main_module,
            &modules,
        );
        Some(PackageArtifact {
            main_module,
            modules,
            hash,
        })
    } else {
        None
    };

    Ok(PackageBuild {
        source: analysis.source.clone(),
        analysis_hash: analysis.analysis_hash.clone(),
        target,
        artifact,
        diagnostics,
        ok,
    })
}

fn load_cached_build(sql: &SqlStorage, cache_key: &str) -> Result<Option<PackageBuild>> {
    #[derive(Deserialize)]
    struct Row {
        build_json: String,
    }

    let rows: Vec<Row> = sql
        .exec(
            "SELECT build_json FROM package_build_cache WHERE cache_key = ?",
            vec![SqlStorageValue::from(cache_key.to_string())],
        )?
        .to_array()?;
    let Some(row) = rows.into_iter().next() else {
        return Ok(None);
    };
    serde_json::from_str(&row.build_json)
        .map(Some)
        .map_err(|err| Error::RustError(format!("invalid cached package build: {}", err)))
}

fn inject_builtin_sdk_files(repo_files: &mut BTreeMap<String, String>) {
    repo_files
        .entry(format!("{}/package.json", GSV_PACKAGE_SDK_ROOT))
        .or_insert_with(|| GSV_PACKAGE_SDK_PACKAGE_JSON.to_string());
    repo_files
        .entry(format!("{}/src/worker.ts", GSV_PACKAGE_SDK_ROOT))
        .or_insert_with(|| GSV_PACKAGE_SDK_WORKER_TS.to_string());
    repo_files
        .entry(format!("{}/src/host.ts", GSV_PACKAGE_SDK_ROOT))
        .or_insert_with(|| GSV_PACKAGE_SDK_HOST_TS.to_string());
    repo_files
        .entry(format!("{}/src/browser.ts", GSV_PACKAGE_SDK_ROOT))
        .or_insert_with(|| GSV_PACKAGE_SDK_BROWSER_TS.to_string());
    repo_files
        .entry(format!("{}/src/index.ts", GSV_PACKAGE_SDK_ROOT))
        .or_insert_with(|| GSV_PACKAGE_SDK_INDEX_TS.to_string());
}

fn store_cached_build(sql: &SqlStorage, cache_key: &str, build: &PackageBuild) -> Result<()> {
    let build_json = serde_json::to_string(build)
        .map_err(|err| Error::RustError(format!("failed to serialize package build cache: {}", err)))?;
    sql.exec(
        "INSERT INTO package_build_cache (cache_key, build_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET build_json = excluded.build_json, updated_at = excluded.updated_at",
        vec![
            SqlStorageValue::from(cache_key.to_string()),
            SqlStorageValue::from(build_json),
            SqlStorageValue::from(current_unix_timestamp()),
        ],
    )?;
    Ok(())
}

async fn materialize_lockfile_dependencies(
    sql: &SqlStorage,
    source: &ResolvedPackageSource,
    repo_files: &mut BTreeMap<String, String>,
) -> Result<()> {
    let plans = if let Some(lockfile_text) = repo_files
        .get(&join_posix(&source.subdir, "package-lock.json"))
        .or_else(|| repo_files.get(&join_posix(&source.subdir, "npm-shrinkwrap.json")))
        .cloned()
    {
        plan_package_lockfile_materialization(&lockfile_text)?
    } else if let Some(lockfile_text) = repo_files
        .get(&join_posix(&source.subdir, "bun.lock"))
        .cloned()
    {
        plan_bun_lockfile_materialization(&lockfile_text)?
    } else {
        return Ok(());
    };

    for plan in plans {
        let package_json_repo_path = join_posix(&source.subdir, &join_posix(&plan.install_path, "package.json"));
        if repo_files.contains_key(&package_json_repo_path) {
            continue;
        }

        let files = load_or_fetch_materialized_dependency(sql, &plan).await?;
        install_materialized_dependency(repo_files, &source.subdir, &plan.install_path, &files);
    }

    Ok(())
}

fn plan_package_lockfile_materialization(lockfile_text: &str) -> Result<Vec<MaterializedDependencyPlan>> {
    let lockfile: PackageLockfile = serde_json::from_str(lockfile_text)
        .map_err(|err| Error::RustError(format!("invalid package-lock.json: {}", err)))?;
    if lockfile.packages.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(version) = lockfile.lockfile_version {
        if version < 2 {
            return Err(Error::RustError(format!(
                "unsupported package-lock version: {}",
                version
            )));
        }
    }

    let mut plans = Vec::new();
    for (install_path, entry) in lockfile.packages {
        if install_path.is_empty() || entry.link || !install_path.contains("node_modules/") {
            continue;
        }
        let Some(resolved_url) = entry.resolved else {
            continue;
        };
        let cache_key = compute_npm_cache_key(&resolved_url, entry.integrity.as_deref());
        plans.push(MaterializedDependencyPlan {
            install_path,
            resolved_url,
            integrity: entry.integrity,
            cache_key,
        });
    }
    Ok(plans)
}

fn plan_bun_lockfile_materialization(lockfile_text: &str) -> Result<Vec<MaterializedDependencyPlan>> {
    let lockfile: BunLockfile = json5::from_str(lockfile_text)
        .map_err(|err| Error::RustError(format!("invalid bun.lock: {}", err)))?;
    if lockfile.packages.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(version) = lockfile.lockfile_version {
        if version != 1 {
            return Err(Error::RustError(format!(
                "unsupported bun.lock version: {}",
                version
            )));
        }
    }

    let mut plans = Vec::new();
    for entry in lockfile.packages.into_values() {
        let Some(plan) = plan_bun_package_entry(&entry)? else {
            continue;
        };
        plans.push(plan);
    }
    plans.sort_by(|a, b| a.install_path.cmp(&b.install_path));
    plans.dedup_by(|a, b| a.install_path == b.install_path);
    Ok(plans)
}

fn plan_bun_package_entry(entry: &BunLockfilePackageEntry) -> Result<Option<MaterializedDependencyPlan>> {
    let package_id = match entry.0.first().and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => return Ok(None),
    };
    let resolved_hint = entry.0.get(1).and_then(Value::as_str).unwrap_or_default();
    let integrity = entry
        .0
        .get(3)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty());
    let (package_name, version) = parse_npm_package_id(package_id)?;
    let resolved_url = if resolved_hint.starts_with("http://") || resolved_hint.starts_with("https://") {
        resolved_hint.to_string()
    } else {
        build_npm_registry_tarball_url(&package_name, &version)
    };
    let cache_key = compute_npm_cache_key(&resolved_url, integrity.as_deref());
    Ok(Some(MaterializedDependencyPlan {
        install_path: join_posix("node_modules", &package_name),
        resolved_url,
        integrity,
        cache_key,
    }))
}

fn parse_npm_package_id(package_id: &str) -> Result<(String, String)> {
    let Some((package_name, version)) = package_id.rsplit_once('@') else {
        return Err(Error::RustError(format!(
            "invalid bun package id: {}",
            package_id
        )));
    };
    if package_name.is_empty() || version.is_empty() {
        return Err(Error::RustError(format!(
            "invalid bun package id: {}",
            package_id
        )));
    }
    Ok((package_name.to_string(), version.to_string()))
}

fn build_npm_registry_tarball_url(package_name: &str, version: &str) -> String {
    let tarball_name = package_name
        .rsplit('/')
        .next()
        .unwrap_or(package_name);
    format!(
        "https://registry.npmjs.org/{}/-/{}-{}.tgz",
        package_name, tarball_name, version
    )
}

async fn load_or_fetch_materialized_dependency(
    sql: &SqlStorage,
    plan: &MaterializedDependencyPlan,
) -> Result<BTreeMap<String, String>> {
    if let Some(files) = load_cached_materialized_dependency(sql, &plan.cache_key)? {
        return Ok(files);
    }

    let files = fetch_materialized_dependency(plan).await?;
    store_cached_materialized_dependency(sql, plan, &files)?;
    Ok(files)
}

fn load_cached_materialized_dependency(
    sql: &SqlStorage,
    cache_key: &str,
) -> Result<Option<BTreeMap<String, String>>> {
    #[derive(Deserialize)]
    struct Row {
        files_json: String,
    }

    let rows: Vec<Row> = sql
        .exec(
            "SELECT files_json FROM package_npm_cache WHERE cache_key = ?",
            vec![SqlStorageValue::from(cache_key.to_string())],
        )?
        .to_array()?;
    let Some(row) = rows.into_iter().next() else {
        return Ok(None);
    };
    serde_json::from_str(&row.files_json)
        .map(Some)
        .map_err(|err| Error::RustError(format!("invalid cached npm package payload: {}", err)))
}

fn store_cached_materialized_dependency(
    sql: &SqlStorage,
    plan: &MaterializedDependencyPlan,
    files: &BTreeMap<String, String>,
) -> Result<()> {
    let files_json = serde_json::to_string(files)
        .map_err(|err| Error::RustError(format!("failed to serialize npm package cache: {}", err)))?;
    sql.exec(
        "INSERT INTO package_npm_cache (cache_key, resolved_url, integrity, files_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           resolved_url = excluded.resolved_url,
           integrity = excluded.integrity,
           files_json = excluded.files_json,
           updated_at = excluded.updated_at",
        vec![
            SqlStorageValue::from(plan.cache_key.clone()),
            SqlStorageValue::from(plan.resolved_url.clone()),
            SqlStorageValue::from(plan.integrity.clone().unwrap_or_default()),
            SqlStorageValue::from(files_json),
            SqlStorageValue::from(current_unix_timestamp()),
        ],
    )?;
    Ok(())
}

async fn fetch_materialized_dependency(
    plan: &MaterializedDependencyPlan,
) -> Result<BTreeMap<String, String>> {
    let url = worker::Url::parse(&plan.resolved_url)
        .map_err(|err| Error::RustError(format!("invalid npm tarball url: {}", err)))?;
    let mut response = Fetch::Url(url).send().await?;
    let status = response.status_code();
    if !(200..300).contains(&status) {
        return Err(Error::RustError(format!(
            "failed to fetch npm tarball (status {}): {}",
            status, plan.resolved_url
        )));
    }
    let bytes = response.bytes().await?;
    if let Some(integrity) = plan.integrity.as_deref() {
        verify_tarball_integrity(&bytes, integrity)?;
    }
    extract_npm_tarball_files(&bytes)
}

fn verify_tarball_integrity(bytes: &[u8], integrity: &str) -> Result<()> {
    let Some((algorithm, expected)) = integrity.split_once('-') else {
        return Err(Error::RustError(format!(
            "invalid npm integrity value: {}",
            integrity
        )));
    };
    let expected = base64::engine::general_purpose::STANDARD
        .decode(expected)
        .map_err(|err| Error::RustError(format!("invalid npm integrity base64: {}", err)))?;
    let actual = match algorithm {
        "sha512" => Sha512::digest(bytes).to_vec(),
        "sha256" => Sha256::digest(bytes).to_vec(),
        "sha1" => {
            let mut hasher = sha1_smol::Sha1::new();
            hasher.update(bytes);
            hasher.digest().bytes().to_vec()
        }
        other => {
            return Err(Error::RustError(format!(
                "unsupported npm integrity algorithm: {}",
                other
            )))
        }
    };
    if actual != expected {
        return Err(Error::RustError("npm tarball integrity mismatch".to_string()));
    }
    Ok(())
}

fn extract_npm_tarball_files(tarball_bytes: &[u8]) -> Result<BTreeMap<String, String>> {
    let decoder = GzDecoder::new(Cursor::new(tarball_bytes));
    let mut archive = Archive::new(decoder);
    let mut files = BTreeMap::new();

    let entries = archive
        .entries()
        .map_err(|err| Error::RustError(format!("failed to read npm tarball: {}", err)))?;
    for entry in entries {
        let mut entry = entry
            .map_err(|err| Error::RustError(format!("failed to read npm tarball entry: {}", err)))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }

        let path = entry
            .path()
            .map_err(|err| Error::RustError(format!("failed to read npm tarball path: {}", err)))?;
        let path = normalize_posix_path(&path.to_string_lossy());
        let Some(stripped_path) = path.strip_prefix("package/") else {
            continue;
        };

        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|err| Error::RustError(format!("failed to read npm tarball file: {}", err)))?;
        if let Ok(text) = String::from_utf8(bytes) {
            files.insert(stripped_path.to_string(), text);
        }
    }

    Ok(files)
}

fn install_materialized_dependency(
    repo_files: &mut BTreeMap<String, String>,
    package_root: &str,
    install_path: &str,
    files: &BTreeMap<String, String>,
) {
    for (path, content) in files {
        let repo_path = join_posix(package_root, &join_posix(install_path, path));
        repo_files.insert(repo_path, content.clone());
    }
}

fn compute_build_cache_key(source: &ResolvedPackageSource, target: PackageBuildTarget) -> String {
    let mut hasher = sha1_smol::Sha1::new();
    hasher.update(PACKAGE_BUILD_CACHE_VERSION.as_bytes());
    hasher.update(source.repo.as_bytes());
    hasher.update(source.requested_ref.as_bytes());
    hasher.update(source.resolved_commit.as_bytes());
    hasher.update(source.subdir.as_bytes());
    hasher.update(match target {
        PackageBuildTarget::DynamicWorker => b"dynamic-worker",
    });
    hasher.digest().to_string()
}

fn compute_npm_cache_key(resolved_url: &str, integrity: Option<&str>) -> String {
    let mut hasher = sha1_smol::Sha1::new();
    hasher.update(PACKAGE_NPM_CACHE_VERSION.as_bytes());
    hasher.update(resolved_url.as_bytes());
    hasher.update(integrity.unwrap_or_default().as_bytes());
    hasher.digest().to_string()
}

fn current_unix_timestamp() -> i64 {
    (js_sys::Date::now() / 1000.0) as i64
}

impl<'a> BundleBuilder<'a> {
    fn seed_main_package(&mut self) -> Result<()> {
        let package_root = &self.analysis.source.subdir;
        let origin = ModuleOrigin::MainPackage {
            root: package_root.clone(),
        };

        let mut has_entry = false;
        for (repo_path, content) in self.repo_files.iter() {
            if !is_path_within_root(repo_path, package_root) {
                continue;
            }
            let relpath = strip_root_prefix(repo_path, package_root);
            if relpath.is_empty() || relpath.starts_with("node_modules/") {
                continue;
            }

            if relpath == "src/package.ts" {
                has_entry = true;
            }

            if relpath == "package.json" {
                self.emitted.insert(
                    relpath.clone(),
                    PackageArtifactModule {
                        path: relpath,
                        kind: PackageArtifactModuleKind::Json,
                        content: content.clone(),
                    },
                );
                continue;
            }

            let kind = infer_module_kind(repo_path);
            if is_source_module(kind) {
                if relpath == "src/package.ts" {
                    self.enqueue(ModuleJob {
                        repo_path: repo_path.clone(),
                        output_path: compiled_source_output_path(&relpath),
                        origin: origin.clone(),
                        target: ModuleTarget::WorkerRuntime,
                    });
                }
            } else {
                self.emitted.insert(
                    relpath.clone(),
                    PackageArtifactModule {
                        path: relpath,
                        kind,
                        content: content.clone(),
                    },
                );
            }
        }

        if let Some(app) = self.analysis.definition.as_ref().and_then(|definition| definition.app.as_ref()) {
            if let Some(browser_entry) = app.browser_entry.as_deref() {
                self.seed_browser_entry(browser_entry)?;
            }
            for asset in app.assets.iter() {
                self.seed_public_asset(asset)?;
            }
        }

        if !has_entry {
            self.push_error(
                "missing-entry-module",
                "src/package.ts",
                1,
                1,
                "package build is missing entry module: src/package.ts".to_string(),
            );
        }

        Ok(())
    }

    fn seed_browser_entry(&mut self, browser_entry: &str) -> Result<()> {
        let package_root = &self.analysis.source.subdir;
        let entry_repo_path = join_posix(package_root, browser_entry.trim_start_matches("./"));
        let entry_relpath = strip_root_prefix(&entry_repo_path, package_root);
        let Some(html_source) = self.repo_files.get(&entry_repo_path) else {
            self.push_error(
                "missing-browser-entry",
                browser_entry,
                1,
                1,
                format!("missing browser entry asset: {}", browser_entry),
            );
            return Ok(());
        };

        let entry_dir = dirname(&entry_relpath);
        let mut rewritten_html = html_source.clone();
        for specifier in extract_html_module_script_specifiers(html_source).into_iter() {
            let candidate = if entry_dir.is_empty() {
                specifier.clone()
            } else {
                normalize_posix_path(&join_posix(&entry_dir, &specifier))
            };
            let Some(repo_path) = resolve_module_path(self.repo_files, &join_posix(package_root, &candidate), None)? else {
                self.push_error(
                    "unresolved-browser-entry",
                    &entry_relpath,
                    1,
                    1,
                    format!("unable to resolve browser module from HTML: {}", specifier),
                );
                continue;
            };
            let output_path = strip_root_prefix(&repo_path, package_root);
            self.enqueue(ModuleJob {
                repo_path,
                output_path: output_path.clone(),
                origin: ModuleOrigin::MainPackage {
                    root: package_root.clone(),
                },
                target: ModuleTarget::BrowserAsset,
            });
            let replacement = relative_asset_specifier(&entry_relpath, &output_path);
            rewritten_html = rewritten_html.replace(&specifier, &replacement);
        }

        self.emitted.insert(
            entry_relpath.clone(),
            PackageArtifactModule {
                path: entry_relpath.clone(),
                kind: PackageArtifactModuleKind::Text,
                content: rewritten_html,
            },
        );
        self.public_assets.insert(entry_relpath, PublicAssetKind::Html);
        Ok(())
    }

    fn seed_public_asset(&mut self, asset_path: &str) -> Result<()> {
        let package_root = &self.analysis.source.subdir;
        let relpath = normalize_posix_path(asset_path.trim_start_matches("./"));
        if relpath.is_empty() {
            self.push_error(
                "invalid-app-asset",
                asset_path,
                1,
                1,
                "app.assets entries must be non-empty package-relative file paths".to_string(),
            );
            return Ok(());
        }
        let repo_path = join_posix(package_root, &relpath);
        let Some(content) = self.repo_files.get(&repo_path) else {
            self.push_error(
                "missing-app-asset",
                &relpath,
                1,
                1,
                format!("missing app asset: {}", relpath),
            );
            return Ok(());
        };
        self.emitted.insert(
            relpath.clone(),
            PackageArtifactModule {
                path: relpath.clone(),
                kind: PackageArtifactModuleKind::Text,
                content: content.clone(),
            },
        );
        self.public_assets
            .insert(relpath.clone(), public_asset_kind_for_path(&relpath));
        Ok(())
    }

    fn process_queue(&mut self) -> Result<()> {
        while let Some(job) = self.queue.pop_front() {
            self.build_source_module(&job)?;
        }
        Ok(())
    }

    fn build_source_module(&mut self, job: &ModuleJob) -> Result<()> {
        if self.emitted.contains_key(&job.output_path) {
            return Ok(());
        }

        let Some(source_text) = self.repo_files.get(&job.repo_path) else {
            self.push_error(
                "missing-source-file",
                &job.output_path,
                1,
                1,
                format!("missing source file for build: {}", job.repo_path),
            );
            return Ok(());
        };

        let source_type = SourceType::from_path(Path::new(&job.repo_path)).unwrap_or(SourceType::ts());
        let parser_allocator = Allocator::default();
        let parser_return = Parser::new(&parser_allocator, source_text, source_type).parse();
        if !parser_return.errors.is_empty() {
            for error in parser_return.errors {
                self.push_error(
                    "parser-error",
                    &job.output_path,
                    1,
                    1,
                    error.to_string(),
                );
            }
            return Ok(());
        }

        let mut replacements = Vec::new();

        for (specifier, occurrences) in parser_return.module_record.requested_modules.iter() {
            let runtime_occurrences = occurrences
                .iter()
                .filter(|occurrence| !occurrence.is_type)
                .copied()
                .collect::<Vec<_>>();
            if runtime_occurrences.is_empty() {
                continue;
            }

            let resolved = match self.resolve_import(job, specifier.as_str()) {
                Ok(Some(value)) => value,
                Ok(None) => continue,
                Err(err) => {
                    self.push_error(
                        "resolve-import",
                        &job.output_path,
                        1,
                        1,
                        err.to_string(),
                    );
                    continue;
                }
            };

            for occurrence in runtime_occurrences {
                replacements.push((occurrence.span, quote_string(&resolved.rewritten_specifier)));
            }
            self.enqueue(resolved.job);
        }

        for dynamic_import in parser_return.module_record.dynamic_imports.iter() {
            let raw = slice_span(source_text, dynamic_import.module_request);
            let Ok(specifier) = serde_json::from_str::<String>(raw) else {
                self.push_error(
                    "unsupported-dynamic-import",
                    &job.output_path,
                    1,
                    1,
                    "dynamic import specifier must be a string literal".to_string(),
                );
                continue;
            };
            let resolved = match self.resolve_import(job, &specifier) {
                Ok(Some(value)) => value,
                Ok(None) => continue,
                Err(err) => {
                    self.push_error(
                        "resolve-import",
                        &job.output_path,
                        1,
                        1,
                        err.to_string(),
                    );
                    continue;
                }
            };
            replacements.push((dynamic_import.module_request, quote_string(&resolved.rewritten_specifier)));
            self.enqueue(resolved.job);
        }

        if job.target == ModuleTarget::BrowserAsset {
            for specifier in extract_browser_worker_specifiers(source_text).into_iter() {
                let resolved = match self.resolve_relative_import(job, &specifier) {
                    Ok(Some(value)) => value,
                    Ok(None) => continue,
                    Err(err) => {
                        self.push_error(
                            "resolve-browser-worker",
                            &job.output_path,
                            1,
                            1,
                            err.to_string(),
                        );
                        continue;
                    }
                };
                self.enqueue(resolved.job);
            }
        }

        let rewritten_source = apply_replacements(source_text, replacements);
        // TODO: Investigate browser-asset runtime performance here before making this
        // the default story for performance-sensitive apps. Since moving
        // `ascii-starfield` off its Bun-built assets and onto this ripgit
        // transpile/serve path, observed FPS appears worse and can feel closer
        // to ~30fps. Likely causes are build output quality/module topology
        // rather than app logic; compare against the previous Bun output before
        // committing to more compiler work.
        let compiled = match transpile_source_module(&job.repo_path, &rewritten_source) {
            Ok(code) => code,
            Err(err) => {
                self.push_error(
                    "transform-error",
                    &job.output_path,
                    1,
                    1,
                    err.to_string(),
                );
                return Ok(());
            }
        };
        let compiled = match rewrite_compiled_imports(&job.repo_path, &compiled, &mut |specifier| {
            let resolved = self.resolve_import(job, specifier)?;
            if let Some(value) = resolved {
                self.enqueue(value.job);
                Ok(Some(value.rewritten_specifier))
            } else {
                Ok(None)
            }
        }) {
            Ok(code) => code,
            Err(err) => {
                self.push_error(
                    "transform-import-rewrite",
                    &job.output_path,
                    1,
                    1,
                    err.to_string(),
                );
                return Ok(());
            }
        };

        self.emitted.insert(
            job.output_path.clone(),
            PackageArtifactModule {
                path: job.output_path.clone(),
                kind: match job.target {
                    ModuleTarget::WorkerRuntime => PackageArtifactModuleKind::SourceModule,
                    ModuleTarget::BrowserAsset => PackageArtifactModuleKind::Text,
                },
                content: compiled,
            },
        );

        if job.target == ModuleTarget::BrowserAsset {
            self.public_assets
                .insert(job.output_path.clone(), public_asset_kind_for_path(&job.output_path));
        }

        Ok(())
    }

    fn resolve_import(&mut self, importer: &ModuleJob, specifier: &str) -> Result<Option<ResolvedImport>> {
        if is_relative_specifier(specifier) {
            return self.resolve_relative_import(importer, specifier);
        }
        if specifier.starts_with('/') {
            self.push_error(
                "unsupported-absolute-import",
                &importer.output_path,
                1,
                1,
                format!("absolute import specifiers are not supported yet: {}", specifier),
            );
            return Ok(None);
        }
        self.resolve_bare_import(importer, specifier)
    }

    fn resolve_relative_import(
        &mut self,
        importer: &ModuleJob,
        specifier: &str,
    ) -> Result<Option<ResolvedImport>> {
        let importer_dir = dirname(&importer.repo_path);
        let candidate = normalize_posix_path(&join_posix(&importer_dir, specifier));
        let Some(repo_path) = resolve_module_path(self.repo_files, &candidate, None)? else {
            self.push_error(
                "unresolved-import",
                &importer.output_path,
                1,
                1,
                format!("unable to resolve relative import: {}", specifier),
            );
            return Ok(None);
        };
        let origin = self.origin_for_repo_path(&repo_path, &importer.origin)?;
        let output_path = output_path_for_origin(&origin, &repo_path, importer.target)?;
        let rewritten_specifier = relative_specifier(&importer.output_path, &output_path);
        Ok(Some(ResolvedImport {
            job: ModuleJob {
                repo_path,
                output_path,
                origin,
                target: importer.target,
            },
            rewritten_specifier,
        }))
    }

    fn resolve_bare_import(
        &mut self,
        importer: &ModuleJob,
        specifier: &str,
    ) -> Result<Option<ResolvedImport>> {
        let (package_name, subpath) = split_package_specifier(specifier);
        let (root, manifest, origin) = self.resolve_dependency_manifest(importer, package_name)?;
        let target_repo_path = if let Some(subpath) = subpath {
            resolve_dependency_subpath(self.repo_files, &root, &manifest, subpath)?
        } else {
            resolve_dependency_entry(self.repo_files, &root, &manifest)?
        };

        let Some(repo_path) = target_repo_path else {
            self.push_error(
                "unresolved-import",
                &importer.output_path,
                1,
                1,
                format!("unable to resolve package import: {}", specifier),
            );
            return Ok(None);
        };

        let output_path = output_path_for_origin(&origin, &repo_path, importer.target)?;
        let rewritten_specifier = relative_specifier(&importer.output_path, &output_path);
        Ok(Some(ResolvedImport {
            job: ModuleJob {
                repo_path,
                output_path,
                origin,
                target: importer.target,
            },
            rewritten_specifier,
        }))
    }

    fn resolve_dependency_manifest(
        &self,
        importer: &ModuleJob,
        package_name: &str,
    ) -> Result<(String, PackageManifestInfo, ModuleOrigin)> {
        if self.analysis.package_json.name == package_name {
            return Ok((
                self.analysis.source.subdir.clone(),
                PackageManifestInfo {
                    name: Some(self.analysis.package_json.name.clone()),
                    main: None,
                    module: None,
                    exports: None,
                },
                ModuleOrigin::MainPackage {
                    root: self.analysis.source.subdir.clone(),
                },
            ));
        }

        let importer_root = importer.origin.root().to_string();
        let importer_dir = dirname(&importer.repo_path);
        for dir in ancestor_dirs(&importer_dir) {
            let candidate_root = join_posix(&dir, &join_posix("node_modules", package_name));
            let package_json_path = join_posix(&candidate_root, "package.json");
            if let Some(package_json_text) = self.repo_files.get(&package_json_path) {
                let manifest = parse_package_manifest(package_json_text)?;
                return Ok((
                    candidate_root.clone(),
                    manifest,
                    ModuleOrigin::Dependency {
                        root: candidate_root,
                        package_name: package_name.to_string(),
                    },
                ));
            }
        }

        if package_name == GSV_PACKAGE_SDK_NAME {
            return Ok((
                GSV_PACKAGE_SDK_ROOT.to_string(),
                PackageManifestInfo {
                    name: Some(GSV_PACKAGE_SDK_NAME.to_string()),
                    main: None,
                    module: None,
                    exports: Some(serde_json::json!({
                        ".": "./src/index.ts",
                        "./browser": "./src/browser.ts",
                        "./worker": "./src/worker.ts",
                        "./host": "./src/host.ts",
                    })),
                },
                ModuleOrigin::Dependency {
                    root: GSV_PACKAGE_SDK_ROOT.to_string(),
                    package_name: package_name.to_string(),
                },
            ));
        }

        if let Some(entry) = self.package_index.get(package_name) {
            return Ok((
                entry.root.clone(),
                entry.manifest.clone(),
                ModuleOrigin::Dependency {
                    root: entry.root.clone(),
                    package_name: package_name.to_string(),
                },
            ));
        }

        Err(Error::RustError(format!(
            "package dependency not found from {}: {}",
            importer_root, package_name
        )))
    }

    fn origin_for_repo_path(
        &self,
        repo_path: &str,
        importer_origin: &ModuleOrigin,
    ) -> Result<ModuleOrigin> {
        if is_path_within_root(repo_path, &self.analysis.source.subdir) {
            return Ok(ModuleOrigin::MainPackage {
                root: self.analysis.source.subdir.clone(),
            });
        }

        if is_path_within_root(repo_path, importer_origin.root()) {
            return Ok(importer_origin.clone());
        }

        let mut best_match: Option<(usize, ModuleOrigin)> = None;
        for (package_name, entry) in self.package_index.iter() {
            if is_path_within_root(repo_path, &entry.root) {
                let len = entry.root.len();
                let origin = ModuleOrigin::Dependency {
                    root: entry.root.clone(),
                    package_name: package_name.clone(),
                };
                if best_match.as_ref().map(|(best_len, _)| len > *best_len).unwrap_or(true) {
                    best_match = Some((len, origin));
                }
            }
        }

        best_match
            .map(|(_, origin)| origin)
            .ok_or_else(|| Error::RustError(format!("unable to determine module origin: {}", repo_path)))
    }

    fn enqueue(&mut self, job: ModuleJob) {
        if self.emitted.contains_key(&job.output_path) {
            return;
        }
        if self.queued_repo_paths.insert(job.repo_path.clone()) {
            self.queue.push_back(job);
        }
    }

    fn push_error(&mut self, code: &str, path: &str, line: u32, column: u32, message: String) {
        self.diagnostics.push(PackageDiagnostic {
            severity: PackageDiagnosticSeverity::Error,
            code: code.to_string(),
            message,
            path: path.to_string(),
            line,
            column,
        });
    }
}

impl ModuleOrigin {
    fn root(&self) -> &str {
        match self {
            Self::MainPackage { root, .. } | Self::Dependency { root, .. } => root,
        }
    }
}

fn transpile_source_module(path: &str, source_text: &str) -> Result<String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(path)).unwrap_or(SourceType::ts());
    let parser_return = Parser::new(&allocator, source_text, source_type).parse();
    if !parser_return.errors.is_empty() {
        return Err(Error::RustError(format!("parse failed for {}", path)));
    }

    let mut program = parser_return.program;
    let semantic = SemanticBuilder::new().with_check_syntax_error(true).build(&program);
    if !semantic.errors.is_empty() {
        return Err(Error::RustError(format!("semantic analysis failed for {}", path)));
    }

    let scoping = semantic.semantic.into_scoping();
    let mut transform_options = TransformOptions::default();
    transform_options.jsx.runtime = JsxRuntime::Automatic;
    transform_options.jsx.import_source = Some("preact".to_string());
    let transform_return = Transformer::new(&allocator, Path::new(path), &transform_options)
        .build_with_scoping(scoping, &mut program);
    if !transform_return.errors.is_empty() {
        return Err(Error::RustError(format!("transform failed for {}", path)));
    }

    Ok(Codegen::new().build(&program).code)
}

fn rewrite_compiled_imports(
    source_path: &str,
    source_text: &str,
    resolve_import: &mut dyn FnMut(&str) -> Result<Option<String>>,
) -> Result<String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(source_path)).unwrap_or(SourceType::ts());
    let parser_return = Parser::new(&allocator, source_text, source_type).parse();
    if !parser_return.errors.is_empty() {
        return Err(Error::RustError(format!(
            "post-transform parse failed for {}",
            source_path
        )));
    }

    let mut replacements = Vec::new();

    for (specifier, occurrences) in parser_return.module_record.requested_modules.iter() {
        if is_relative_specifier(specifier.as_str()) || specifier.as_str().starts_with('/') {
            continue;
        }
        let runtime_occurrences = occurrences
            .iter()
            .filter(|occurrence| !occurrence.is_type)
            .copied()
            .collect::<Vec<_>>();
        if runtime_occurrences.is_empty() {
            continue;
        }

        let resolved = match resolve_import(specifier.as_str())? {
            Some(value) => value,
            None => continue,
        };

        for occurrence in runtime_occurrences {
            replacements.push((occurrence.span, quote_string(&resolved)));
        }
    }

    for dynamic_import in parser_return.module_record.dynamic_imports.iter() {
        let raw = slice_span(source_text, dynamic_import.module_request);
        let Ok(specifier) = serde_json::from_str::<String>(raw) else {
            return Err(Error::RustError(format!(
                "dynamic import specifier must be a string literal in {}",
                source_path
            )));
        };
        if is_relative_specifier(&specifier) || specifier.starts_with('/') {
            continue;
        }
        let resolved = match resolve_import(&specifier)? {
            Some(value) => value,
            None => continue,
        };
        replacements.push((dynamic_import.module_request, quote_string(&resolved)));
    }

    Ok(apply_replacements(source_text, replacements))
}

fn index_repo_packages(
    repo_files: &BTreeMap<String, String>,
    current_root: &str,
) -> Result<BTreeMap<String, RepoPackageManifest>> {
    let mut index = BTreeMap::new();
    for (path, content) in repo_files.iter() {
        if !path.ends_with("/package.json") && path != "package.json" {
            continue;
        }
        let root = dirname(path);
        if same_package_root(&root, current_root) {
            continue;
        }
        let manifest = parse_package_manifest(content)?;
        let Some(name) = manifest.name.clone() else {
            continue;
        };
        index.entry(name).or_insert(RepoPackageManifest { root, manifest });
    }
    Ok(index)
}

fn parse_package_manifest(source: &str) -> Result<PackageManifestInfo> {
    serde_json::from_str(source)
        .map_err(|err| Error::RustError(format!("invalid dependency package.json: {}", err)))
}

fn resolve_dependency_entry(
    repo_files: &BTreeMap<String, String>,
    root: &str,
    manifest: &PackageManifestInfo,
) -> Result<Option<String>> {
    if let Some(exports) = manifest.exports.as_ref() {
        if let Some(entry) = resolve_exports_entry(exports, None) {
            if let Some(resolved) = resolve_module_path(repo_files, &join_posix(root, &entry), Some(manifest))? {
                return Ok(Some(resolved));
            }
        }
    }

    for candidate in [manifest.module.as_deref(), manifest.main.as_deref()] {
        if let Some(candidate) = candidate {
            if let Some(resolved) = resolve_module_path(repo_files, &join_posix(root, candidate), Some(manifest))? {
                return Ok(Some(resolved));
            }
        }
    }

    for fallback in ["src/index.ts", "src/index.tsx", "index.ts", "index.js"] {
        if let Some(resolved) = resolve_module_path(repo_files, &join_posix(root, fallback), Some(manifest))? {
            return Ok(Some(resolved));
        }
    }

    Ok(None)
}

fn resolve_dependency_subpath(
    repo_files: &BTreeMap<String, String>,
    root: &str,
    manifest: &PackageManifestInfo,
    subpath: &str,
) -> Result<Option<String>> {
    if let Some(exports) = manifest.exports.as_ref() {
        if let Some(entry) = resolve_exports_entry(exports, Some(subpath)) {
            if let Some(resolved) = resolve_module_path(repo_files, &join_posix(root, &entry), Some(manifest))? {
                return Ok(Some(resolved));
            }
        }
    }

    resolve_module_path(repo_files, &join_posix(root, subpath), Some(manifest))
}

fn resolve_exports_entry(exports: &Value, subpath: Option<&str>) -> Option<String> {
    match exports {
        Value::String(value) => {
            if subpath.is_none() {
                Some(value.clone())
            } else {
                None
            }
        }
        Value::Object(map) => {
            if let Some(subpath) = subpath {
                let key = format!("./{}", subpath);
                map.get(&key).and_then(resolve_exports_target)
            } else if let Some(value) = map.get(".") {
                resolve_exports_target(value)
            } else {
                resolve_exports_target(exports)
            }
        }
        _ => None,
    }
}

fn resolve_exports_target(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Object(map) => map
            .get("worker")
            .or_else(|| map.get("browser"))
            .or_else(|| map.get("import"))
            .or_else(|| map.get("default"))
            .and_then(resolve_exports_target),
        _ => None,
    }
}

fn resolve_module_path(
    repo_files: &BTreeMap<String, String>,
    candidate: &str,
    manifest: Option<&PackageManifestInfo>,
) -> Result<Option<String>> {
    let normalized = normalize_posix_path(candidate);
    if repo_files.contains_key(&normalized) {
        return Ok(Some(normalized));
    }

    if let Some(source) = resolve_directory_module(repo_files, &normalized, manifest)? {
        return Ok(Some(source));
    }

    if has_known_extension(&normalized) {
        return Ok(None);
    }

    for extension in [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs", ".json"] {
        let candidate = format!("{}{}", normalized, extension);
        if repo_files.contains_key(&candidate) {
            return Ok(Some(candidate));
        }
    }

    for extension in ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mts", "index.mjs", "index.cts", "index.cjs", "index.json"] {
        let candidate = format!("{}/{}", normalized, extension);
        if repo_files.contains_key(&candidate) {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
}

fn resolve_directory_module(
    repo_files: &BTreeMap<String, String>,
    root: &str,
    _manifest: Option<&PackageManifestInfo>,
) -> Result<Option<String>> {
    let package_json_path = join_posix(root, "package.json");
    let Some(package_json_text) = repo_files.get(&package_json_path) else {
        return Ok(None);
    };
    let manifest = parse_package_manifest(package_json_text)?;
    resolve_dependency_entry(repo_files, root, &manifest)
}

fn collect_repo_utf8_files_at_commit(
    sql: &SqlStorage,
    commit_hash: &str,
) -> Result<BTreeMap<String, String>> {
    #[derive(Deserialize)]
    struct CommitRow {
        tree_hash: String,
    }

    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(commit_hash.to_string())],
        )?
        .to_array()?;
    let Some(commit) = commits.into_iter().next() else {
        return Ok(BTreeMap::new());
    };

    let mut files = BTreeMap::new();
    collect_utf8_files_under_tree(sql, &commit.tree_hash, "", &mut files)?;
    Ok(files)
}

fn collect_utf8_files_under_tree(
    sql: &SqlStorage,
    tree_hash: &str,
    prefix: &str,
    files: &mut BTreeMap<String, String>,
) -> Result<()> {
    #[derive(Deserialize)]
    struct TreeRow {
        name: String,
        mode: i64,
        entry_hash: String,
    }

    let rows: Vec<TreeRow> = sql
        .exec(
            "SELECT name, mode, entry_hash FROM trees WHERE tree_hash = ? ORDER BY name",
            vec![SqlStorageValue::from(tree_hash.to_string())],
        )?
        .to_array()?;

    for entry in rows {
        let path = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{}/{}", prefix, entry.name)
        };

        if entry.mode == 0o040000 {
            collect_utf8_files_under_tree(sql, &entry.entry_hash, &path, files)?;
            continue;
        }

        let Some(bytes) = crate::store::reconstruct_blob_by_hash(sql, &entry.entry_hash)? else {
            return Err(Error::RustError(format!("missing blob for package file: {}", path)));
        };
        if let Ok(text) = String::from_utf8(bytes) {
            files.insert(path, text);
        }
    }

    Ok(())
}

fn compute_artifact_hash(
    source: &ResolvedPackageSource,
    analysis_hash: &str,
    target: PackageBuildTarget,
    main_module: &str,
    modules: &[PackageArtifactModule],
) -> String {
    let mut hasher = sha1_smol::Sha1::new();
    hasher.update(source.resolved_commit.as_bytes());
    hasher.update(analysis_hash.as_bytes());
    hasher.update(match target {
        PackageBuildTarget::DynamicWorker => b"dynamic-worker",
    });
    hasher.update(main_module.as_bytes());
    for module in modules {
        hasher.update(module.path.as_bytes());
        hasher.update(match module.kind {
            PackageArtifactModuleKind::SourceModule => b"source-module",
            PackageArtifactModuleKind::Json => b"json",
            PackageArtifactModuleKind::Text => b"text",
        });
        hasher.update(module.content.as_bytes());
    }
    hasher.digest().to_string()
}

fn infer_module_kind(path: &str) -> PackageArtifactModuleKind {
    if path.ends_with(".json") {
        return PackageArtifactModuleKind::Json;
    }
    if has_source_extension(path) {
        return PackageArtifactModuleKind::SourceModule;
    }
    PackageArtifactModuleKind::Text
}

fn is_source_module(kind: PackageArtifactModuleKind) -> bool {
    kind == PackageArtifactModuleKind::SourceModule
}

fn has_source_extension(path: &str) -> bool {
    path.ends_with(".ts")
        || path.ends_with(".tsx")
        || path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".mts")
        || path.ends_with(".mjs")
        || path.ends_with(".cts")
        || path.ends_with(".cjs")
}

fn has_known_extension(path: &str) -> bool {
    has_source_extension(path) || path.ends_with(".json")
}

fn split_package_specifier(specifier: &str) -> (&str, Option<&str>) {
    if let Some(rest) = specifier.strip_prefix('@') {
        let mut parts = rest.splitn(3, '/');
        let scope = parts.next().unwrap_or_default();
        let name = parts.next().unwrap_or_default();
        let package_name_len = scope.len() + name.len() + 2;
        let package_name = &specifier[..package_name_len];
        let subpath = parts.next();
        (package_name, subpath)
    } else {
        let mut parts = specifier.splitn(2, '/');
        let package_name = parts.next().unwrap_or_default();
        let subpath = parts.next();
        (package_name, subpath)
    }
}

fn output_path_for_origin(origin: &ModuleOrigin, repo_path: &str, target: ModuleTarget) -> Result<String> {
    let root = origin.root();
    let relpath = strip_root_prefix(repo_path, root);
    match target {
        ModuleTarget::WorkerRuntime => match origin {
            ModuleOrigin::MainPackage { .. } => Ok(compiled_output_path(&relpath)),
            ModuleOrigin::Dependency { package_name, .. } => Ok(join_posix(
                &join_posix("__deps", package_name),
                &compiled_output_path(&relpath),
            )),
        },
        ModuleTarget::BrowserAsset => match origin {
            ModuleOrigin::MainPackage { .. } => Ok(relpath),
            ModuleOrigin::Dependency { package_name, .. } => Ok(join_posix(
                &join_posix("node_modules", package_name),
                &relpath,
            )),
        },
    }
}

fn compiled_output_path(relpath: &str) -> String {
    if has_source_extension(relpath) {
        compiled_source_output_path(relpath)
    } else {
        relpath.to_string()
    }
}

fn compiled_source_output_path(relpath: &str) -> String {
    let path = Path::new(relpath);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or(relpath);
    let parent = dirname(relpath);
    let filename = format!("{}.js", stem);
    if parent.is_empty() {
        filename
    } else {
        join_posix(&parent, &filename)
    }
}

fn public_asset_kind_for_path(path: &str) -> PublicAssetKind {
    if path.ends_with(".html") {
        return PublicAssetKind::Html;
    }
    if path.ends_with(".json") {
        return PublicAssetKind::Json;
    }
    if path.ends_with(".css") {
        return PublicAssetKind::Css;
    }
    if path.ends_with(".svg") {
        return PublicAssetKind::Svg;
    }
    if has_source_extension(path) {
        return PublicAssetKind::JavaScript;
    }
    PublicAssetKind::Text
}

fn extract_html_module_script_specifiers(source: &str) -> Vec<String> {
    let mut specifiers = Vec::new();
    let mut remaining = source;
    while let Some(start) = remaining.find("<script") {
        remaining = &remaining[start + "<script".len()..];
        let Some(end) = remaining.find('>') else {
            break;
        };
        let tag = &remaining[..end];
        if !(tag.contains("type=\"module\"") || tag.contains("type='module'")) {
            remaining = &remaining[end + 1..];
            continue;
        }
        if let Some(src) = extract_html_attribute(tag, "src") {
            specifiers.push(src);
        }
        remaining = &remaining[end + 1..];
    }
    specifiers
}

fn extract_html_attribute(tag: &str, attribute: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{}={}", attribute, quote);
        if let Some(start) = tag.find(&needle) {
            let rest = &tag[start + needle.len()..];
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn extract_browser_worker_specifiers(source: &str) -> Vec<String> {
    let mut specifiers = Vec::new();
    let mut remaining = source;
    while let Some(start) = remaining.find("new URL(") {
        remaining = &remaining[start + "new URL(".len()..];
        let Some(quote) = remaining.chars().next() else {
            break;
        };
        if quote != '"' && quote != '\'' {
            continue;
        }
        let rest = &remaining[1..];
        let Some(end) = rest.find(quote) else {
            break;
        };
        let specifier = &rest[..end];
        let tail = &rest[end + 1..];
        if tail.trim_start().starts_with(", import.meta.url") {
            specifiers.push(specifier.to_string());
        }
        remaining = tail;
    }
    specifiers
}

fn relative_asset_specifier(from_path: &str, to_path: &str) -> String {
    relative_specifier(from_path, to_path)
}

fn generate_dynamic_worker_main_module(
    analysis: &PackageAnalysis,
    public_assets: &BTreeMap<String, PublicAssetKind>,
) -> String {
    let package_name = quote_string(&analysis.package_json.name);
    let package_id = quote_string(&analysis.package_json.name);
    let browser_entry = analysis
        .definition
        .as_ref()
        .and_then(|definition| definition.app.as_ref())
        .and_then(|app| app.browser_entry.as_deref())
        .map(|value| quote_string(&normalize_posix_path(value.trim_start_matches("./"))))
        .unwrap_or_else(|| "null".to_string());
    let app_rpc_methods = analysis
        .definition
        .as_ref()
        .and_then(|definition| definition.app.as_ref())
        .map(|app| {
            app.rpc_methods
                .iter()
                .map(|name| {
                    let quoted = quote_string(name);
                    format!(
                        "  async [{}](args) {{\n    return this.__invoke({}, args);\n  }}\n",
                        quoted, quoted,
                    )
                })
                .collect::<String>()
        })
        .unwrap_or_default();

    let mut asset_imports = String::new();
    let mut asset_entries = String::new();
    for (index, (path, kind)) in public_assets.iter().enumerate() {
        let import_name = format!("__gsv_asset_{}", index);
        let import_path = relative_specifier("__gsv__/main.js", path);
        let content_type = match kind {
            PublicAssetKind::Html => "text/html; charset=utf-8",
            PublicAssetKind::JavaScript => "text/javascript; charset=utf-8",
            PublicAssetKind::Json => "application/json; charset=utf-8",
            PublicAssetKind::Css => "text/css; charset=utf-8",
            PublicAssetKind::Svg => "image/svg+xml; charset=utf-8",
            PublicAssetKind::Text => "text/plain; charset=utf-8",
        };
        asset_imports.push_str(&format!(
            "import {} from {};\n",
            import_name,
            quote_string(&import_path),
        ));
        asset_entries.push_str(&format!(
            "  [{} , {{ content: {}, contentType: {} }}],\n",
            quote_string(path),
            import_name,
            quote_string(content_type),
        ));
    }

    format!(
        r#"{asset_imports}import {{ DurableObject, RpcTarget, WorkerEntrypoint }} from "cloudflare:workers";
import definition from "../src/package.js";

const STATIC_META = Object.freeze({{
  packageName: {package_name},
  packageId: {package_id},
  routeBase: null,
}});
const BROWSER_ENTRY = {browser_entry};
const STATIC_ASSETS = new Map([
{asset_entries}]);

let setupPromise = null;
const LIVE_SIGNAL_WATCH_TTL_MS = 24 * 60 * 60 * 1000;

function mergeMeta(overrides) {{
  if (!overrides) {{
    return STATIC_META;
  }}
  return {{
    ...STATIC_META,
    ...overrides,
  }};
}}

function resolveAppFrame(env, props) {{
  const frame = props?.appFrame && typeof props.appFrame === "object"
    ? props.appFrame
    : (env.GSV_APP_FRAME && typeof env.GSV_APP_FRAME === "object" ? env.GSV_APP_FRAME : null);
  return frame && typeof frame === "object"
    ? {{
        uid: typeof frame.uid === "number" ? frame.uid : 0,
        username: typeof frame.username === "string" ? frame.username : "",
        packageId: typeof frame.packageId === "string" ? frame.packageId : (env.GSV_PACKAGE_ID ?? STATIC_META.packageId),
        packageName: typeof frame.packageName === "string" ? frame.packageName : (env.GSV_PACKAGE_NAME ?? STATIC_META.packageName),
        entrypointName: typeof frame.entrypointName === "string" ? frame.entrypointName : "",
        routeBase: typeof frame.routeBase === "string" ? frame.routeBase : (env.GSV_ROUTE_BASE ?? STATIC_META.routeBase),
        issuedAt: typeof frame.issuedAt === "number" ? frame.issuedAt : Date.now(),
        expiresAt: typeof frame.expiresAt === "number" ? frame.expiresAt : (Date.now() + 365 * 24 * 60 * 60 * 1000),
      }}
    : null;
}}

function buildKernelClient(env, props, kernelOverride) {{
  if (kernelOverride && typeof kernelOverride.request === "function") {{
    return kernelOverride;
  }}
  if (props?.kernel && typeof props.kernel.request === "function") {{
    return props.kernel;
  }}
  if (env.KERNEL && typeof env.KERNEL.request === "function") {{
    return env.KERNEL;
  }}
  return {{
    async request() {{
      throw new Error("kernel binding is unavailable");
    }},
  }};
}}

function createBaseContext(env, metaOverrides, props, kernelOverride) {{
  return {{
    meta: mergeMeta(metaOverrides),
    viewer: props?.appFrame && typeof props.appFrame === "object"
      ? {{
          uid: typeof props.appFrame.uid === "number" ? props.appFrame.uid : 0,
          username: typeof props.appFrame.username === "string" ? props.appFrame.username : "",
        }}
      : {{ uid: 0, username: "" }},
    app: props?.appSession && typeof props.appSession === "object"
      ? {{
          sessionId: typeof props.appSession.sessionId === "string" ? props.appSession.sessionId : "",
          clientId: typeof props.appSession.clientId === "string" ? props.appSession.clientId : "",
          rpcBase: typeof props.appSession.rpcBase === "string" ? props.appSession.rpcBase : "",
          expiresAt: typeof props.appSession.expiresAt === "number" ? props.appSession.expiresAt : 0,
        }}
      : undefined,
    kernel: buildKernelClient(env, props, kernelOverride),
  }};
}}

async function ensureSetup(ctx) {{
  if (typeof definition.setup !== "function") {{
    return;
  }}
  if (!setupPromise) {{
    setupPromise = Promise.resolve(definition.setup(ctx));
  }}
  await setupPromise;
}}

function noOpStdin() {{
  return {{
    async text() {{
      return "";
    }},
  }};
}}

function normalizeTrigger(trigger) {{
  if (!trigger || typeof trigger !== "object") {{
    return {{ kind: "manual" }};
  }}
  return {{
    kind: typeof trigger.kind === "string" ? trigger.kind : "manual",
    scheduledAt: typeof trigger.scheduledAt === "number" ? trigger.scheduledAt : undefined,
  }};
}}

function getAppDefinition() {{
  const app = definition && definition.app;
  if (!app || typeof app !== "object") {{
    return null;
  }}
  return app;
}}

function getAppRpcHandler(app, method) {{
  if (!app || !app.rpc || typeof app.rpc !== "object") {{
    return null;
  }}
  const handler = app.rpc[method];
  if (typeof handler !== "function") {{
    return null;
  }}
  return handler;
}}

function deserializeHttpRequest(input) {{
  const headers = new Headers(Array.isArray(input?.headers) ? input.headers : []);
  const init = {{
    method: typeof input?.method === "string" ? input.method : "GET",
    headers,
  }};
  if (input?.body instanceof ArrayBuffer) {{
    init.body = input.body;
  }}
  return new Request(typeof input?.url === "string" ? input.url : "http://localhost/", init);
}}

async function serializeHttpResponse(response) {{
  const headers = Array.from(response.headers.entries());
  const body = response.body ? await response.arrayBuffer() : null;
  return {{
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
  }};
}}

function serveStaticAsset(request, routeBase) {{
  if (!BROWSER_ENTRY) {{
    return null;
  }}
  const url = new URL(request.url);
  if (url.pathname === routeBase) {{
    return Response.redirect(`${{url.origin}}${{routeBase}}/`, 302);
  }}
  if (request.method !== "GET" && request.method !== "HEAD") {{
    return null;
  }}
  let assetPath = null;
  if (url.pathname === `${{routeBase}}/` || url.pathname === `${{routeBase}}/index.html`) {{
    assetPath = BROWSER_ENTRY;
  }} else if (url.pathname.startsWith(`${{routeBase}}/`)) {{
    assetPath = url.pathname.slice(routeBase.length + 1);
  }}
  if (!assetPath) {{
    return null;
  }}
  const asset = STATIC_ASSETS.get(assetPath);
  if (!asset) {{
    return null;
  }}
  return new Response(request.method === "HEAD" ? null : asset.content, {{
    headers: {{
      "content-type": asset.contentType,
      "cache-control": "no-store",
    }},
  }});
}}

function requireNamedHandler(groupName, handlerName) {{
  const group = definition && definition[groupName];
  if (!group || typeof group !== "object") {{
    throw new Error(`package has no ${{groupName}} handlers`);
  }}
  const handler = group[handlerName];
  if (typeof handler !== "function") {{
    throw new Error(`unknown package ${{groupName}} handler: ${{handlerName}}`);
  }}
  return handler;
}}

export default class GsvAppEntrypoint extends WorkerEntrypoint {{
  async fetch(request) {{
    const app = getAppDefinition();
    if (!app) {{
      return new Response("Not Found", {{ status: 404 }});
    }}
    const props = this.ctx.props ?? {{}};
    const ctx = createBaseContext(this.env, {{
      packageId: props.appFrame?.packageId ?? props.packageId ?? this.env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: props.appFrame?.routeBase ?? props.routeBase ?? this.env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    }}, props);
    const routeBase = ctx.meta.routeBase ?? "/";
    const assetResponse = serveStaticAsset(request, routeBase);
    if (assetResponse) {{
      return assetResponse;
    }}
    if (typeof app.fetch !== "function") {{
      return new Response("Not Found", {{ status: 404 }});
    }}
    await ensureSetup(ctx);
    return app.fetch(request, ctx);
  }}
}}

export class GsvCommandEntrypoint extends WorkerEntrypoint {{
  async run(input) {{
    const props = this.ctx.props ?? {{}};
    const resolvedCommandName =
      typeof input === "string" && input.length > 0
        ? input
        : props.commandName;
    if (typeof resolvedCommandName !== "string" || resolvedCommandName.length === 0) {{
      throw new Error("package command name is required");
    }}
    const commandInput = input && typeof input === "object" ? input : {{}};
    const stdoutChunks = [];
    const stderrChunks = [];
    const ctx = {{
      ...createBaseContext(this.env, {{
        packageId: props.packageId ?? this.env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
        routeBase: props.routeBase ?? this.env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
      }}, props),
      argv: Array.isArray(commandInput.args)
        ? commandInput.args
        : (Array.isArray(props.argv) ? props.argv : []),
      stdin: typeof commandInput.stdin === "string"
        ? {{
            async text() {{
              return commandInput.stdin;
            }},
          }}
        : (props.stdin ?? noOpStdin()),
      stdout: props.stdout ?? {{
        async write(value) {{
          stdoutChunks.push(String(value ?? ""));
        }},
      }},
      stderr: props.stderr ?? {{
        async write(value) {{
          stderrChunks.push(String(value ?? ""));
        }},
      }},
    }};
    await ensureSetup(ctx);
    const handler = requireNamedHandler("commands", resolvedCommandName);
    await handler(ctx);
    return {{
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      exitCode: 0,
    }};
  }}
}}

export class GsvTaskEntrypoint extends WorkerEntrypoint {{
  async run(taskName) {{
    const props = this.ctx.props ?? {{}};
    const resolvedTaskName =
      typeof taskName === "string" && taskName.length > 0
        ? taskName
        : props.taskName;
    if (typeof resolvedTaskName !== "string" || resolvedTaskName.length === 0) {{
      throw new Error("package task name is required");
    }}
    const ctx = {{
      ...createBaseContext(this.env, {{
        packageId: props.packageId ?? STATIC_META.packageId,
        routeBase: props.routeBase ?? STATIC_META.routeBase,
      }}),
      taskName: resolvedTaskName,
      trigger: normalizeTrigger(props.trigger),
      payload: props.payload,
    }};
    await ensureSetup(ctx);
    const handler = requireNamedHandler("tasks", resolvedTaskName);
    return handler(ctx);
  }}
}}

export class GsvAppSignalEntrypoint extends WorkerEntrypoint {{
  async run(signalName) {{
    const props = this.ctx.props ?? {{}};
    const app = getAppDefinition();
    if (!app || typeof app.onSignal !== "function") {{
      throw new Error("package app has no onSignal handler");
    }}
    const resolvedSignalName =
      typeof signalName === "string" && signalName.length > 0
        ? signalName
        : props.signal;
    if (typeof resolvedSignalName !== "string" || resolvedSignalName.length === 0) {{
      throw new Error("package signal name is required");
    }}
    const ctx = {{
      ...createBaseContext(this.env, {{
        packageId: props.appFrame?.packageId ?? props.packageId ?? STATIC_META.packageId,
        routeBase: props.appFrame?.routeBase ?? props.routeBase ?? STATIC_META.routeBase,
      }}, props),
      signal: resolvedSignalName,
      payload: props.payload,
      sourcePid: typeof props.sourcePid === "string" ? props.sourcePid : undefined,
      watch: props.watch && typeof props.watch === "object"
        ? {{
            id: typeof props.watch.id === "string" ? props.watch.id : "",
            key: typeof props.watch.key === "string" ? props.watch.key : undefined,
            state: props.watch.state,
            createdAt: typeof props.watch.createdAt === "number" ? props.watch.createdAt : undefined,
          }}
        : {{ id: "" }},
    }};
    await ensureSetup(ctx);
    return app.onSignal(ctx);
  }}
}}

export class GsvAppFacet extends DurableObject {{
  constructor(ctx, env) {{
    super(ctx, env);
    const app = getAppDefinition();
    if (!app) {{
      throw new Error("package has no app definition");
    }}
    this.__gsvApp = app;
    this.__gsvMeta = {{
      packageId: env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    }};
    this.__gsvSignalSubscriptions = new Map();
    this.__gsvSignalWatchRefs = new Map();
  }}

  __context(runtime, kernel) {{
    const appFrame = runtime?.appFrame ?? resolveAppFrame(this.env, {{}});
    return createBaseContext(this.env, {{
      packageId: appFrame?.packageId ?? this.__gsvMeta.packageId,
      routeBase: appFrame?.routeBase ?? this.__gsvMeta.routeBase,
    }}, {{
      ...(appFrame ? {{ appFrame }} : {{}}),
      ...(runtime?.appSession ? {{ appSession: runtime.appSession }} : {{}}),
    }}, kernel);
  }}

  async __invoke(method, args, runtime, kernel) {{
    const ctx = this.__context(runtime, kernel);
    await ensureSetup(ctx);
    const handler = getAppRpcHandler(this.__gsvApp, method);
    if (!handler) {{
      throw new Error(`Unknown app RPC method: ${{method}}`);
    }}
    return handler(args, ctx);
  }}

  __watchKey(signal, processId) {{
    return `__gsv_live__:${{signal}}:${{processId ?? "*"}}`;
  }}

  async gsvSubscribeSignal(args, runtime, kernel) {{
    const ctx = this.__context(runtime, kernel);
    await ensureSetup(ctx);
    const signals = Array.isArray(args?.signals)
      ? Array.from(new Set(args.signals.filter((value) => typeof value === "string" && value.length > 0)))
      : [];
    if (signals.length === 0) {{
      throw new Error("signals are required");
    }}
    const processId =
      typeof args?.processId === "string" && args.processId.length > 0
        ? args.processId
        : undefined;
    const sink = args?.sink;
    if (!sink || typeof sink.onSignal !== "function") {{
      throw new Error("signal sink must implement onSignal()");
    }}

    const subscriptionId = crypto.randomUUID();
    const watchKeys = [];
    for (const signal of signals) {{
      const watchKey = this.__watchKey(signal, processId ?? null);
      let bucket = this.__gsvSignalWatchRefs.get(watchKey);
      if (!bucket) {{
        await ctx.kernel.request("signal.watch", {{
          signal,
          ...(processId ? {{ processId }} : {{}}),
          key: watchKey,
          once: false,
          ttlMs: LIVE_SIGNAL_WATCH_TTL_MS,
          state: {{
            source: "gsv-live-subscription",
            signal,
            processId: processId ?? null,
          }},
        }});
        bucket = {{
          signal,
          processId: processId ?? null,
          subscribers: new Map(),
        }};
        this.__gsvSignalWatchRefs.set(watchKey, bucket);
      }}
      bucket.subscribers.set(subscriptionId, sink);
      watchKeys.push(watchKey);
    }}

    this.__gsvSignalSubscriptions.set(subscriptionId, watchKeys);
    return {{ subscriptionId }};
  }}

  async gsvUnsubscribeSignal(args, runtime, kernel) {{
    const ctx = this.__context(runtime, kernel);
    const subscriptionId =
      typeof args?.subscriptionId === "string" && args.subscriptionId.length > 0
        ? args.subscriptionId
        : "";
    if (!subscriptionId) {{
      return {{ removed: false }};
    }}
    const watchKeys = this.__gsvSignalSubscriptions.get(subscriptionId);
    if (!watchKeys) {{
      return {{ removed: false }};
    }}
    this.__gsvSignalSubscriptions.delete(subscriptionId);
    for (const watchKey of watchKeys) {{
      const bucket = this.__gsvSignalWatchRefs.get(watchKey);
      if (!bucket) {{
        continue;
      }}
      bucket.subscribers.delete(subscriptionId);
      if (bucket.subscribers.size > 0) {{
        continue;
      }}
      this.__gsvSignalWatchRefs.delete(watchKey);
      await ctx.kernel.request("signal.unwatch", {{ key: watchKey }}).catch(() => {{}});
    }}
    return {{ removed: true }};
  }}

  async gsvHandleSignal(signalName, payload, sourcePid, watch, runtime, kernel) {{
    const ctx = this.__context(runtime, kernel);
    await ensureSetup(ctx);

    if (typeof this.__gsvApp.onSignal === "function") {{
      await this.__gsvApp.onSignal({{
        ...ctx,
        signal: signalName,
        payload,
        sourcePid: typeof sourcePid === "string" ? sourcePid : undefined,
        watch: watch && typeof watch === "object"
          ? {{
              id: typeof watch.id === "string" ? watch.id : "",
              key: typeof watch.key === "string" ? watch.key : undefined,
              state: watch.state,
              createdAt: typeof watch.createdAt === "number" ? watch.createdAt : undefined,
            }}
          : {{ id: "" }},
      }});
    }}

    const watchKey = watch && typeof watch.key === "string"
      ? watch.key
      : this.__watchKey(
          signalName,
          watch && watch.state && typeof watch.state.processId === "string"
            ? watch.state.processId
            : null,
        );
    const bucket = this.__gsvSignalWatchRefs.get(watchKey);
    if (!bucket || bucket.subscribers.size === 0) {{
      return;
    }}

    const stale = [];
    await Promise.all(Array.from(bucket.subscribers.entries()).map(async ([subscriptionId, sink]) => {{
      try {{
        await sink.onSignal(signalName, {{
          payload,
          sourcePid: typeof sourcePid === "string" ? sourcePid : null,
          watch,
        }});
      }} catch {{
        stale.push(subscriptionId);
      }}
    }}));

    for (const subscriptionId of stale) {{
      bucket.subscribers.delete(subscriptionId);
      this.__gsvSignalSubscriptions.delete(subscriptionId);
    }}
  }}

  async gsvFetch(input, runtime, kernel) {{
    const request = deserializeHttpRequest(input);
    const ctx = this.__context(runtime, kernel);
    const app = this.__gsvApp;
    if (!app) {{
      return serializeHttpResponse(new Response("Not Found", {{ status: 404 }}));
    }}
    const routeBase = ctx.meta.routeBase ?? "/";
    const assetResponse = serveStaticAsset(request, routeBase);
    if (assetResponse) {{
      return serializeHttpResponse(assetResponse);
    }}
    if (typeof app.fetch !== "function") {{
      return serializeHttpResponse(new Response("Not Found", {{ status: 404 }}));
    }}
    await ensureSetup(ctx);
    return serializeHttpResponse(await app.fetch(request, ctx));
  }}

  async fetch(request) {{
    const result = await this.gsvFetch({{
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      body: request.body ? await request.arrayBuffer() : null,
    }}, undefined, undefined);
    return new Response(result.body ?? null, {{
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    }});
  }}

  async gsvInvoke(method, args, runtime, kernel) {{
    return this.__invoke(method, args, runtime, kernel);
  }}

{app_rpc_methods}}}

class GsvPackageAppBackend extends RpcTarget {{
  constructor(env, props) {{
    super();
    const app = getAppDefinition();
    if (!app || !app.rpc || typeof app.rpc !== "object") {{
      throw new Error("package app has no rpc handlers");
    }}
    const ctx = createBaseContext(env, {{
      packageId: props.appFrame?.packageId ?? props.packageId ?? env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: props.appFrame?.routeBase ?? props.routeBase ?? env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    }}, props);
    this.__gsvCtx = ctx;
    this.__gsvApp = app;
    this.__gsvSetupReady = null;
  }}

  async __invoke(method, args) {{
    if (!this.__gsvSetupReady) {{
      this.__gsvSetupReady = ensureSetup(this.__gsvCtx);
    }}
    await this.__gsvSetupReady;
    const handler = getAppRpcHandler(this.__gsvApp, method);
    if (!handler) {{
      throw new Error(`Unknown app RPC method: ${{method}}`);
    }}
    return handler(args, this.__gsvCtx);
  }}

{app_rpc_methods}}}

export class GsvAppRpcEntrypoint extends WorkerEntrypoint {{
  async getBackend() {{
    const app = getAppDefinition();
    if (!app || !app.rpc || typeof app.rpc !== "object") {{
      throw new Error("package app has no rpc handlers");
    }}
    return new GsvPackageAppBackend(this.env, this.ctx.props ?? {{}});
  }}
}}
"#,
        asset_imports = asset_imports,
        app_rpc_methods = app_rpc_methods,
        package_name = package_name,
        package_id = package_id,
        browser_entry = browser_entry,
        asset_entries = asset_entries,
    )
}

fn is_relative_specifier(specifier: &str) -> bool {
    specifier.starts_with("./") || specifier.starts_with("../")
}

fn relative_specifier(from_output_path: &str, to_output_path: &str) -> String {
    let from_dir = dirname(from_output_path);
    let from_parts = split_segments(&from_dir);
    let to_parts = split_segments(to_output_path);

    let mut common = 0usize;
    while common < from_parts.len() && common < to_parts.len() && from_parts[common] == to_parts[common] {
        common += 1;
    }

    let mut parts = Vec::new();
    for _ in common..from_parts.len() {
        parts.push("..".to_string());
    }
    for part in &to_parts[common..] {
        parts.push((*part).to_string());
    }

    if parts.is_empty() {
        "./".to_string()
    } else {
        let joined = parts.join("/");
        if joined.starts_with("../") {
            joined
        } else {
            format!("./{}", joined)
        }
    }
}

fn apply_replacements(source_text: &str, mut replacements: Vec<(Span, String)>) -> String {
    replacements.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    let mut output = source_text.to_string();
    for (span, replacement) in replacements {
        let start = span.start as usize;
        let end = span.end as usize;
        output.replace_range(start..end, &replacement);
    }
    output
}

fn quote_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{}\"", value))
}

fn slice_span<'a>(source_text: &'a str, span: Span) -> &'a str {
    let start = span.start as usize;
    let end = span.end as usize;
    &source_text[start.min(source_text.len())..end.min(source_text.len())]
}

fn is_path_within_root(path: &str, root: &str) -> bool {
    if root.is_empty() || root == "." {
        return true;
    }
    path == root || path.starts_with(&(root.to_string() + "/"))
}

fn strip_root_prefix(path: &str, root: &str) -> String {
    if root.is_empty() || root == "." {
        return path.to_string();
    }
    if path == root {
        String::new()
    } else {
        path.strip_prefix(&(root.to_string() + "/")).unwrap_or(path).to_string()
    }
}

fn same_package_root(left: &str, right: &str) -> bool {
    ((left.is_empty() || left == ".") && (right.is_empty() || right == ".")) || left == right
}

fn join_posix(left: &str, right: &str) -> String {
    if left.is_empty() {
        return normalize_posix_path(right);
    }
    if right.is_empty() {
        return normalize_posix_path(left);
    }
    normalize_posix_path(&format!("{}/{}", left.trim_end_matches('/'), right.trim_start_matches('/')))
}

fn dirname(path: &str) -> String {
    path.rsplit_once('/').map(|(dir, _)| dir.to_string()).unwrap_or_default()
}

fn normalize_posix_path(path: &str) -> String {
    let mut parts = Vec::new();
    let normalized = path.replace('\\', "/");
    for segment in normalized.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn split_segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|segment| !segment.is_empty()).collect()
}

fn ancestor_dirs(path: &str) -> Vec<String> {
    let parts = split_segments(path);
    let mut dirs = Vec::new();
    for end in (0..=parts.len()).rev() {
        dirs.push(parts[..end].join("/"));
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tar::Builder;

    fn sample_source() -> ResolvedPackageSource {
        ResolvedPackageSource {
            repo: "system/gsv".to_string(),
            requested_ref: "main".to_string(),
            resolved_commit: "abc123".to_string(),
            subdir: "gateway/packages/example".to_string(),
        }
    }

    #[test]
    fn build_package_source_transpiles_typescript_and_rewrites_relative_imports() {
        let analysis = analyze_package_source(
            sample_source(),
            r#"{ "name": "@gsv/example", "version": "0.1.0" }"#.to_string(),
            r#"
              import { definePackage } from "@gsv/package/worker";
              export default definePackage({
                meta: { displayName: "Example" },
              });
            "#
            .to_string(),
        )
        .unwrap();

        let repo_files = BTreeMap::from([
            (
                "gateway/packages/example/package.json".to_string(),
                r#"{ "name": "@gsv/example", "version": "0.1.0" }"#.to_string(),
            ),
            (
                "gateway/packages/example/src/package.ts".to_string(),
                r#"
                  import { definePackage } from "@gsv/package/worker";
                  import { value } from "./util";
                  const title: string = value;
                  export default definePackage({
                    meta: { displayName: "Example" },
                  });
                "#
                .to_string(),
            ),
            (
                "gateway/packages/example/src/util.ts".to_string(),
                "export const value: string = \"Example\";".to_string(),
            ),
            (
                "packages/package/package.json".to_string(),
                r#"{ "name": "@gsv/package", "exports": { "./browser": "./src/browser.ts", "./worker": "./src/worker.ts" } }"#.to_string(),
            ),
            (
                "packages/package/src/worker.ts".to_string(),
                "export function definePackage(value: unknown): unknown { return value; }".to_string(),
            ),
        ]);

        let build = build_package_from_repo_files(&analysis, &repo_files, PackageBuildTarget::DynamicWorker).unwrap();
        assert!(build.ok, "{:?}", build.diagnostics);
        let artifact = build.artifact.unwrap();
        assert_eq!(artifact.main_module, "__gsv__/main.js");
        let entry = artifact.modules.iter().find(|module| module.path == "src/package.js").unwrap();
        assert!(entry.content.contains("./util.js"));
        assert!(!entry.content.contains(": string"));
        let util = artifact.modules.iter().find(|module| module.path == "src/util.js").unwrap();
        assert!(!util.content.contains(": string"));
        let bootstrap = artifact.modules.iter().find(|module| module.path == "__gsv__/main.js").unwrap();
        assert!(bootstrap.content.contains("import definition from \"../src/package.js\";"));
        assert!(bootstrap.content.contains("export class GsvCommandEntrypoint extends WorkerEntrypoint"));
        assert!(transpile_source_module("__gsv__/main.js", &bootstrap.content).is_ok());
    }

    #[test]
    fn build_from_repo_files_resolves_workspace_dependency_imports() {
        let analysis = analyze_package_source(
            sample_source(),
            r#"{ "name": "@gsv/example", "version": "0.1.0" }"#.to_string(),
            r#"
              import { definePackage } from "@gsv/package/worker";
              export default definePackage({
                meta: { displayName: "Example" },
              });
            "#
            .to_string(),
        )
        .unwrap();

        let repo_files = BTreeMap::from([
            (
                "gateway/packages/example/package.json".to_string(),
                r#"{ "name": "@gsv/example", "version": "0.1.0" }"#.to_string(),
            ),
            (
                "gateway/packages/example/src/package.ts".to_string(),
                "import { definePackage } from \"@gsv/package/worker\"; export default definePackage({ meta: { displayName: \"Example\" } });".to_string(),
            ),
            (
                "packages/package/package.json".to_string(),
                r#"{ "name": "@gsv/package", "exports": { "./browser": "./src/browser.ts", "./worker": "./src/worker.ts" } }"#.to_string(),
            ),
            (
                "packages/package/src/worker.ts".to_string(),
                "export function definePackage(value: unknown): unknown { return value; }".to_string(),
            ),
        ]);

        let build = build_package_from_repo_files(&analysis, &repo_files, PackageBuildTarget::DynamicWorker).unwrap();
        assert!(build.ok);
        let artifact = build.artifact.unwrap();
        let entry = artifact.modules.iter().find(|module| module.path == "src/package.js").unwrap();
        assert!(entry.content.contains("../__deps/@gsv/package/src/worker.js"));
        assert!(artifact.modules.iter().any(|module| module.path == "__deps/@gsv/package/src/worker.js"));
    }

    #[test]
    fn build_package_source_returns_no_artifact_for_invalid_analysis() {
        let analysis = analyze_package_source(
            sample_source(),
            r#"{ "name": "@gsv/example" }"#.to_string(),
            r#"
              export default definePackage({
                meta: { displayName: "Example" },
              });
            "#
            .to_string(),
        )
        .unwrap();

        let build = build_package_source(&analysis, BTreeMap::new(), PackageBuildTarget::DynamicWorker).unwrap();
        assert!(!build.ok);
        assert!(build.artifact.is_none());
        assert!(build
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "missing-define-package-import"));
    }

    #[test]
    fn plan_package_lockfile_materialization_extracts_installable_packages() {
        let plans = plan_package_lockfile_materialization(
            r#"{
              "name": "example",
              "lockfileVersion": 3,
              "packages": {
                "": {},
                "node_modules/react": {
                  "resolved": "https://registry.npmjs.org/react/-/react-1.0.0.tgz",
                  "integrity": "sha512-AAAA"
                },
                "node_modules/@scope/pkg": {
                  "resolved": "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz",
                  "integrity": "sha512-BBBB"
                },
                "node_modules/local-link": {
                  "link": true
                }
              }
            }"#,
        )
        .unwrap();

        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].install_path, "node_modules/@scope/pkg");
        assert_eq!(plans[1].install_path, "node_modules/react");
        assert!(plans[0].cache_key.len() >= 8);
    }

    #[test]
    fn plan_bun_lockfile_materialization_extracts_installable_packages() {
        let plans = plan_bun_lockfile_materialization(
            r#"{
              "lockfileVersion": 1,
              "workspaces": {
                "": {
                  "name": "@gsv/example",
                  "dependencies": {
                    "@scope/pkg": "1.0.0",
                    "react": "1.0.0",
                  },
                },
              },
              "packages": {
                "react": ["react@1.0.0", "", {}, "sha512-AAAA"],
                "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-BBBB"],
              }
            }"#,
        )
        .unwrap();

        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].install_path, "node_modules/@scope/pkg");
        assert_eq!(plans[0].resolved_url, "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz");
        assert_eq!(plans[1].install_path, "node_modules/react");
        assert_eq!(plans[1].resolved_url, "https://registry.npmjs.org/react/-/react-1.0.0.tgz");
    }

    #[test]
    fn extract_npm_tarball_files_reads_package_prefix_and_verifies_integrity() {
        let tarball = build_test_npm_tarball(&[
            (
                "package/package.json",
                r#"{ "name": "left-pad", "main": "index.js" }"#,
            ),
            ("package/index.js", "export default function leftPad() {}"),
            ("package/README.md", "# left-pad"),
        ]);

        let expected_integrity = {
            let digest = Sha512::digest(&tarball);
            format!(
                "sha512-{}",
                base64::engine::general_purpose::STANDARD.encode(digest)
            )
        };

        verify_tarball_integrity(&tarball, &expected_integrity).unwrap();
        let files = extract_npm_tarball_files(&tarball).unwrap();
        assert_eq!(
            files.get("package.json").map(String::as_str),
            Some(r#"{ "name": "left-pad", "main": "index.js" }"#)
        );
        assert_eq!(
            files.get("index.js").map(String::as_str),
            Some("export default function leftPad() {}")
        );
        assert!(files.contains_key("README.md"));
    }

    #[test]
    fn install_materialized_dependency_mounts_files_under_package_root() {
        let mut repo_files = BTreeMap::new();
        let dep_files = BTreeMap::from([
            ("package.json".to_string(), r#"{ "name": "left-pad" }"#.to_string()),
            ("index.js".to_string(), "export default 1;".to_string()),
        ]);

        install_materialized_dependency(
            &mut repo_files,
            "gateway/packages/example",
            "node_modules/left-pad",
            &dep_files,
        );

        assert_eq!(
            repo_files
                .get("gateway/packages/example/node_modules/left-pad/package.json")
                .map(String::as_str),
            Some(r#"{ "name": "left-pad" }"#)
        );
        assert_eq!(
            repo_files
                .get("gateway/packages/example/node_modules/left-pad/index.js")
                .map(String::as_str),
            Some("export default 1;")
        );
    }

    fn build_test_npm_tarball(entries: &[(&str, &str)]) -> Vec<u8> {
        let buffer = Vec::new();
        let encoder = GzEncoder::new(buffer, Compression::default());
        let mut builder = Builder::new(encoder);

        for (path, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, *path, contents.as_bytes())
                .expect("append tar entry");
        }

        let encoder = builder.into_inner().expect("finish tar builder");
        encoder.finish().expect("finish gzip encoder")
    }
}
