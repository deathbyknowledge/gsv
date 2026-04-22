use std::collections::{BTreeMap, BTreeSet};

use crate::diagnostics::{has_errors, PackageAssemblyDiagnostic};
use crate::graph::{build_module_graph_for_entry, ModuleGraph};
use crate::model::{
    PackageAssemblyAnalysis, PackageAssemblyArtifactModule, PackageAssemblyArtifactModuleKind,
};
use crate::npm::InstalledAssembly;
use crate::oxc::{collect_module_request_spans_with_oxc, OxcResolver};
use crate::pipeline::StageOutcome;
use crate::virtual_fs::{relative_specifier, relativize_to_root, resolve_from_root};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAssembly {
    pub main_module: String,
    pub graphs: Vec<ModuleGraph>,
    pub generated_modules: Vec<PackageAssemblyArtifactModule>,
}

pub fn build_runtime_assembly(
    analysis: &PackageAssemblyAnalysis,
    installed: &InstalledAssembly,
) -> StageOutcome<RuntimeAssembly> {
    let mut diagnostics = Vec::new();
    let mut graphs = Vec::new();
    let mut browser_graph = None;

    let definition_repo_path = resolve_from_root(&analysis.package_root, "src/package.ts");
    if !installed.files.contains(&definition_repo_path) {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "contract.definition-source-missing",
            "Package definition source file src/package.ts is missing from the package snapshot.",
            definition_repo_path,
        ));
        return StageOutcome::failure(diagnostics);
    }

    let definition_graph = build_module_graph_for_entry(installed, &definition_repo_path);
    diagnostics.extend(definition_graph.diagnostics);
    let Some(definition_graph) = definition_graph.value else {
        return StageOutcome::failure(diagnostics);
    };
    graphs.push(definition_graph);

    if let Some(browser_entry) = installed.browser_entry.as_deref() {
        let browser_graph_outcome = build_module_graph_for_entry(installed, browser_entry);
        diagnostics.extend(browser_graph_outcome.diagnostics);
        let Some(resolved_browser_graph) = browser_graph_outcome.value else {
            return StageOutcome::failure(diagnostics);
        };
        browser_graph = Some(resolved_browser_graph.clone());
        graphs.push(resolved_browser_graph);
    }

    if let Some(backend_entry) = installed.backend_entry.as_deref() {
        let backend_graph = build_module_graph_for_entry(installed, backend_entry);
        diagnostics.extend(backend_graph.diagnostics);
        let Some(backend_graph) = backend_graph.value else {
            return StageOutcome::failure(diagnostics);
        };
        graphs.push(backend_graph);
    }

    let mut seen_command_paths = BTreeSet::new();
    for entry_path in installed.command_entries.values() {
        if !seen_command_paths.insert(entry_path.clone()) {
            continue;
        }
        let command_graph = build_module_graph_for_entry(installed, entry_path);
        diagnostics.extend(command_graph.diagnostics);
        let Some(command_graph) = command_graph.value else {
            return StageOutcome::failure(diagnostics);
        };
        graphs.push(command_graph);
    }

    let generated_modules = generate_runtime_modules(
        analysis,
        installed,
        &definition_repo_path,
        browser_graph.as_ref(),
    );
    diagnostics.extend(generated_modules.diagnostics);
    let Some(generated_modules) = generated_modules.value else {
        return StageOutcome::failure(diagnostics);
    };

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    StageOutcome::success(
        RuntimeAssembly {
            main_module: "__gsv__/main.ts".to_string(),
            graphs,
            generated_modules,
        },
        diagnostics,
    )
}

fn generate_runtime_modules(
    analysis: &PackageAssemblyAnalysis,
    installed: &InstalledAssembly,
    definition_repo_path: &str,
    browser_graph: Option<&ModuleGraph>,
) -> StageOutcome<Vec<PackageAssemblyArtifactModule>> {
    let mut modules = Vec::new();
    let mut asset_imports = Vec::new();
    let mut asset_entries = Vec::new();
    let mut command_imports = Vec::new();
    let mut command_entries = Vec::new();
    let mut diagnostics = Vec::new();

    for (index, asset_path) in installed.asset_paths.iter().enumerate() {
        let artifact_asset_path = relativize_to_root(asset_path, &analysis.package_root);
        let generated_path = format!("__gsv_assets__/{index}.ts");
        let content = installed.files.get(asset_path).unwrap_or_default();
        modules.push(PackageAssemblyArtifactModule {
            path: generated_path.clone(),
            kind: PackageAssemblyArtifactModuleKind::SourceModule,
            content: format!(
                "export default {};\n",
                serde_json::to_string(content).unwrap()
            ),
        });
        asset_imports.push(format!(
            "import __gsv_asset_{index} from {};",
            serde_json::to_string(&relative_specifier("__gsv__/main.ts", &generated_path)).unwrap()
        ));
        asset_entries.push(format!(
            "  [{}, {{ content: __gsv_asset_{index}, contentType: {} }}],",
            serde_json::to_string(&artifact_asset_path).unwrap(),
            serde_json::to_string(content_type_for_path(&artifact_asset_path)).unwrap(),
        ));
    }

    let browser_assets = if let Some(browser_graph) = browser_graph {
        let generated = generate_browser_runtime_assets(browser_graph, analysis, installed);
        diagnostics.extend(generated.diagnostics);
        let Some(browser_assets) = generated.value else {
            return StageOutcome::failure(diagnostics);
        };
        Some(browser_assets)
    } else {
        None
    };
    let browser_shell_html = if let Some(browser_assets) = browser_assets {
        for (index, asset) in browser_assets.assets.iter().enumerate() {
            let generated_path = format!("__gsv_browser_assets__/{index}.ts");
            modules.push(PackageAssemblyArtifactModule {
                path: generated_path.clone(),
                kind: PackageAssemblyArtifactModuleKind::SourceModule,
                content: format!(
                    "export default {};\n",
                    serde_json::to_string(&asset.content).unwrap()
                ),
            });
            asset_imports.push(format!(
                "import __gsv_browser_asset_{index} from {};",
                serde_json::to_string(&relative_specifier("__gsv__/main.ts", &generated_path))
                    .unwrap()
            ));
            asset_entries.push(format!(
                "  [{}, {{ content: __gsv_browser_asset_{index}, contentType: {} }}],",
                serde_json::to_string(&asset.route_path).unwrap(),
                serde_json::to_string(asset.content_type).unwrap(),
            ));
        }
        Some(browser_assets.shell_html)
    } else {
        None
    };

    let backend_import = if let Some(backend_entry) = installed.backend_entry.as_ref() {
        let artifact_backend_path = relativize_to_root(backend_entry, &analysis.package_root);
        format!(
            "import GsvPackageBackendModule from {};",
            serde_json::to_string(&relative_specifier(
                "__gsv__/main.ts",
                &artifact_backend_path
            ))
            .unwrap()
        )
    } else {
        "const GsvPackageBackendModule = null;".to_string()
    };

    for (index, (command_name, entry_path)) in installed.command_entries.iter().enumerate() {
        let artifact_command_path = relativize_to_root(entry_path, &analysis.package_root);
        command_imports.push(format!(
            "import __gsv_command_{index} from {};",
            serde_json::to_string(&relative_specifier(
                "__gsv__/main.ts",
                &artifact_command_path
            ))
            .unwrap()
        ));
        command_entries.push(format!(
            "  [{}, __gsv_command_{index}],",
            serde_json::to_string(command_name).unwrap(),
        ));
    }

    let definition_artifact_path = relativize_to_root(definition_repo_path, &analysis.package_root);

    let app_rpc_methods = analysis
        .definition
        .as_ref()
        .and_then(|definition| definition.app.as_ref())
        .map(|app| {
            app.rpc_methods
                .iter()
                .map(|name| {
                    format!(
                        "  async [{name_json}](args) {{\n    return this.__invoke({name_json}, args);\n  }}\n",
                        name_json = serde_json::to_string(name).unwrap()
                    )
                })
                .collect::<String>()
        })
        .unwrap_or_default();

    let asset_import_block = join_import_block(&asset_imports);
    let command_import_block = join_import_block(&command_imports);
    let wrapper = format!(
        r#"{asset_import_block}{command_import_block}import {{ RpcTarget, WorkerEntrypoint }} from "cloudflare:workers";
import definition from {definition_import};
{backend_import}

const STATIC_META = Object.freeze({{
  packageName: {package_name},
  packageId: {package_id},
  routeBase: null,
}});
const BROWSER_ENTRY = {browser_entry};
const APP_SHELL_HTML = {app_shell_html};
const STATIC_ASSETS = new Map([
{asset_entries}
]);
const COMMAND_MODULES = new Map([
{command_entries}
]);

let setupPromise = null;

function mergeMeta(overrides) {{
  if (!overrides) {{
    return STATIC_META;
  }}
  return {{
    ...STATIC_META,
    ...overrides,
  }};
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

function buildDaemonClient(daemonOverride, triggerOverride) {{
  if (
    !daemonOverride
    || typeof daemonOverride.upsertRpcSchedule !== "function"
    || typeof daemonOverride.removeRpcSchedule !== "function"
    || typeof daemonOverride.listRpcSchedules !== "function"
  ) {{
    return undefined;
  }}
  const trigger = triggerOverride && typeof triggerOverride === "object"
    ? {{
        kind: "schedule",
        key: typeof triggerOverride.key === "string" ? triggerOverride.key : "",
        scheduledAt: typeof triggerOverride.scheduledAt === "number" ? triggerOverride.scheduledAt : 0,
        firedAt: typeof triggerOverride.firedAt === "number" ? triggerOverride.firedAt : 0,
      }}
    : undefined;
  return {{
    async upsertRpcSchedule(input) {{
      return daemonOverride.upsertRpcSchedule(input);
    }},
    async removeRpcSchedule(key) {{
      return daemonOverride.removeRpcSchedule(key);
    }},
    async listRpcSchedules() {{
      return daemonOverride.listRpcSchedules();
    }},
    ...(trigger ? {{ trigger }} : {{}}),
  }};
}}

function createBaseContext(metaOverrides, props, env, kernelOverride, daemonOverride, daemonTrigger) {{
  const appFrame = props?.appFrame && typeof props.appFrame === "object" ? props.appFrame : null;
  return {{
    meta: mergeMeta(metaOverrides),
    viewer: appFrame
      ? {{
          uid: typeof appFrame.uid === "number" ? appFrame.uid : 0,
          username: typeof appFrame.username === "string" ? appFrame.username : "",
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
    daemon: buildDaemonClient(daemonOverride, daemonTrigger),
    kernel: buildKernelClient(env, props, kernelOverride),
  }};
}}

async function ensureSetup(ctx) {{
  if (typeof definition?.setup !== "function") {{
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

function createBackendInstance(ctx) {{
  if (typeof GsvPackageBackendModule !== "function") {{
    return null;
  }}
  const backend = new GsvPackageBackendModule();
  backend.meta = ctx.meta;
  backend.kernel = ctx.kernel;
  backend.viewer = ctx.viewer;
  if (ctx.app) {{
    backend.app = ctx.app;
  }}
  if (ctx.daemon) {{
    backend.daemon = ctx.daemon;
  }}
  return backend;
}}

function getBackendRpcHandler(backend, method) {{
  if (!backend || typeof method !== "string") {{
    return null;
  }}
  if (
    method === "constructor"
    || method === "fetch"
    || method === "onSignal"
    || method.startsWith("__")
  ) {{
    return null;
  }}
  const handler = backend[method];
  if (typeof handler !== "function") {{
    return null;
  }}
  return handler.bind(backend);
}}

function getCommandHandler(commandName) {{
  const handler = COMMAND_MODULES.get(commandName);
  if (typeof handler === "function") {{
    return handler;
  }}
  const group = definition && definition.commands;
  if (!group || typeof group !== "object") {{
    return null;
  }}
  const legacyHandler = group[commandName];
  return typeof legacyHandler === "function" ? legacyHandler : null;
}}

function serveStaticAsset(request, routeBase) {{
  if (!BROWSER_ENTRY) {{
    return null;
  }}
  const url = new URL(request.url);
  if (url.pathname === routeBase) {{
    const canonicalUrl = new URL(`${{routeBase}}/`, url.origin);
    canonicalUrl.search = url.search;
    return Response.redirect(canonicalUrl.toString(), 302);
  }}
  if (request.method !== "GET" && request.method !== "HEAD") {{
    return null;
  }}
  if ((url.pathname === `${{routeBase}}/` || url.pathname === `${{routeBase}}/index.html`) && APP_SHELL_HTML) {{
    return new Response(request.method === "HEAD" ? null : APP_SHELL_HTML, {{
      headers: {{
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      }},
    }});
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

export default class GsvAppEntrypoint extends WorkerEntrypoint {{
  async fetch(request) {{
    const props = this.ctx.props ?? {{}};
    const ctx = createBaseContext({{
      packageId: props.appFrame?.packageId ?? props.packageId ?? this.env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: props.appFrame?.routeBase ?? props.routeBase ?? this.env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    }}, props, this.env);
    const routeBase = ctx.meta.routeBase ?? "/";
    const assetResponse = serveStaticAsset(request, routeBase);
    if (assetResponse) {{
      return assetResponse;
    }}
    const backend = createBackendInstance(ctx);
    if (backend && typeof backend.fetch === "function") {{
      return backend.fetch(request);
    }}
    const app = getAppDefinition();
    if (!app || typeof app.fetch !== "function") {{
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
      ...createBaseContext({{
        packageId: props.packageId ?? this.env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
        routeBase: props.routeBase ?? this.env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
      }}, props, this.env),
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
    const handler = getCommandHandler(resolvedCommandName);
    if (typeof handler !== "function") {{
      throw new Error(`unknown package command handler: ${{resolvedCommandName}}`);
    }}
    await handler(ctx);
    return {{
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      exitCode: 0,
    }};
  }}
}}

export class GsvAppSignalEntrypoint extends WorkerEntrypoint {{
  async run(signalName) {{
    const props = this.ctx.props ?? {{}};
    const resolvedSignalName =
      typeof signalName === "string" && signalName.length > 0
        ? signalName
        : props.signal;
    if (typeof resolvedSignalName !== "string" || resolvedSignalName.length === 0) {{
      throw new Error("package signal name is required");
    }}
    const ctx = {{
      ...createBaseContext({{
        packageId: props.appFrame?.packageId ?? props.packageId ?? STATIC_META.packageId,
        routeBase: props.appFrame?.routeBase ?? props.routeBase ?? STATIC_META.routeBase,
      }}, props, this.env, undefined, undefined, props.daemonTrigger),
      signal: resolvedSignalName,
      payload: props.payload,
      sourcePid: typeof props.sourcePid === "string" ? props.sourcePid : undefined,
      watch: props.watch && typeof props.watch === "object" ? props.watch : undefined,
    }};
    const backend = createBackendInstance(ctx);
    if (backend && typeof backend.onSignal === "function") {{
      await backend.onSignal({{
        signal: ctx.signal,
        payload: ctx.payload,
        sourcePid: ctx.sourcePid,
        watch: ctx.watch,
      }});
      return;
    }}
    const app = getAppDefinition();
    if (!app || typeof app.onSignal !== "function") {{
      throw new Error("package app has no onSignal handler");
    }}
    await ensureSetup(ctx);
    await app.onSignal(ctx);
  }}
}}

class GsvPackageAppBackend extends RpcTarget {{
  constructor(env, props) {{
    super();
    const ctx = createBaseContext({{
      packageId: props.appFrame?.packageId ?? props.packageId ?? env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: props.appFrame?.routeBase ?? props.routeBase ?? env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    }}, props, env);
    this.__gsvCtx = ctx;
    this.__gsvApp = getAppDefinition();
    this.__gsvBackend = createBackendInstance(ctx);
    this.__gsvSetupReady = null;
  }}

  async __invoke(method, args) {{
    const backendHandler = getBackendRpcHandler(this.__gsvBackend, method);
    if (backendHandler) {{
      return backendHandler(args);
    }}
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
    const hasLegacyRpc = Boolean(app && app.rpc && typeof app.rpc === "object");
    const hasBackend = typeof GsvPackageBackendModule === "function";
    if (!hasLegacyRpc && !hasBackend) {{
      throw new Error("package app has no backend rpc");
    }}
    return new GsvPackageAppBackend(this.env, this.ctx.props ?? {{}});
  }}
}}
"#,
        asset_import_block = asset_import_block,
        command_import_block = command_import_block,
        definition_import = serde_json::to_string(&relative_specifier(
            "__gsv__/main.ts",
            &definition_artifact_path
        ))
        .unwrap(),
        backend_import = backend_import,
        package_name = serde_json::to_string(&analysis.package_json.name).unwrap(),
        package_id = serde_json::to_string(&analysis.package_json.name).unwrap(),
        browser_entry = browser_graph
            .map(|graph| emitted_browser_route_path(&graph.main_module, &analysis.package_root))
            .map(|path| serde_json::to_string(&path).unwrap())
            .unwrap_or_else(|| "null".to_string()),
        app_shell_html = browser_shell_html
            .map(|path| serde_json::to_string(&path).unwrap())
            .unwrap_or_else(|| "null".to_string()),
        asset_entries = asset_entries.join("\n"),
        command_entries = command_entries.join("\n"),
    );

    modules.push(PackageAssemblyArtifactModule {
        path: "__gsv__/main.ts".to_string(),
        kind: PackageAssemblyArtifactModuleKind::SourceModule,
        content: wrapper,
    });
    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }
    StageOutcome::success(modules, diagnostics)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserRuntimeAssets {
    shell_html: String,
    assets: Vec<BrowserRuntimeAsset>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserRuntimeAsset {
    route_path: String,
    content_type: &'static str,
    content: String,
}

fn generate_browser_runtime_assets(
    browser_graph: &ModuleGraph,
    analysis: &PackageAssemblyAnalysis,
    installed: &InstalledAssembly,
) -> StageOutcome<BrowserRuntimeAssets> {
    let mut diagnostics = Vec::new();
    let resolver = OxcResolver::new(installed.files.clone());
    let mut route_map = BTreeMap::new();
    let mut emitted_paths = BTreeMap::<String, String>::new();

    for module in &browser_graph.modules {
        match module.kind {
            PackageAssemblyArtifactModuleKind::SourceModule
            | PackageAssemblyArtifactModuleKind::Json => {
                let route_path = emitted_browser_route_path(&module.path, &analysis.package_root);
                if let Some(existing) =
                    emitted_paths.insert(route_path.clone(), module.path.clone())
                {
                    if existing != module.path {
                        diagnostics.push(PackageAssemblyDiagnostic::error(
                            "browser.emit-path-conflict",
                            format!(
                                "Browser module emit path collision between {existing} and {}.",
                                module.path
                            ),
                            module.path.clone(),
                        ));
                    }
                }
                route_map.insert(module.path.clone(), route_path);
            }
            PackageAssemblyArtifactModuleKind::Commonjs
            | PackageAssemblyArtifactModuleKind::Text
            | PackageAssemblyArtifactModuleKind::Data => {
                diagnostics.push(PackageAssemblyDiagnostic::error(
                    "browser.unsupported-module-kind",
                    format!(
                        "Browser entry graph cannot emit {:?} module {}.",
                        module.kind, module.path
                    ),
                    module.path.clone(),
                ));
            }
        }
    }

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    let mut assets = Vec::new();
    for module in &browser_graph.modules {
        let Some(route_path) = route_map.get(&module.path) else {
            continue;
        };
        let content = match module.kind {
            PackageAssemblyArtifactModuleKind::SourceModule => {
                match rewrite_browser_module_source(module, route_path, &route_map, &resolver) {
                    Ok(content) => content,
                    Err(error) => {
                        diagnostics.push(error);
                        continue;
                    }
                }
            }
            PackageAssemblyArtifactModuleKind::Json => {
                format!("export default {};\n", module.content)
            }
            PackageAssemblyArtifactModuleKind::Commonjs
            | PackageAssemblyArtifactModuleKind::Text
            | PackageAssemblyArtifactModuleKind::Data => continue,
        };
        assets.push(BrowserRuntimeAsset {
            route_path: route_path.clone(),
            content_type: "text/javascript; charset=utf-8",
            content,
        });
    }

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    let shell_html = build_browser_shell_html(
        &emitted_browser_route_path(&browser_graph.main_module, &analysis.package_root),
        &installed
            .asset_paths
            .iter()
            .filter_map(|asset_path| {
                let route_path = relativize_to_root(asset_path, &analysis.package_root);
                route_path.ends_with(".css").then_some(route_path)
            })
            .collect::<Vec<_>>(),
    );

    StageOutcome::success(BrowserRuntimeAssets { shell_html, assets }, diagnostics)
}

fn rewrite_browser_module_source(
    module: &PackageAssemblyArtifactModule,
    route_path: &str,
    route_map: &BTreeMap<String, String>,
    resolver: &OxcResolver,
) -> Result<String, PackageAssemblyDiagnostic> {
    let mut rewritten = module.content.clone();
    let rewrites = collect_module_request_spans_with_oxc(&module.path, &module.content)?
        .into_iter()
        .map(|request| {
            let resolved = resolver.resolve_specifier(&module.path, &request.specifier)?;
            let target_route_path = route_map.get(&resolved.repo_path).ok_or_else(|| {
                PackageAssemblyDiagnostic::error(
                    "browser.unsupported-specifier",
                    format!(
                        "Browser module {} depends on unsupported module {}.",
                        module.path, resolved.repo_path
                    ),
                    module.path.clone(),
                )
            })?;
            Ok((
                request.start,
                request.end,
                serde_json::to_string(&relative_specifier(route_path, target_route_path)).unwrap(),
            ))
        })
        .collect::<Result<Vec<_>, PackageAssemblyDiagnostic>>()?;
    for (start, end, replacement) in rewrites.into_iter().rev() {
        rewritten.replace_range(start..end, &replacement);
    }
    Ok(rewritten)
}

fn emitted_browser_route_path(module_path: &str, package_root: &str) -> String {
    let artifact_path = relativize_to_root(module_path, package_root);
    let emitted = match artifact_path.rsplit_once('.') {
        Some((stem, extension)) => match extension.to_ascii_lowercase().as_str() {
            "js" | "jsx" | "ts" | "tsx" | "mjs" | "mts" | "cjs" | "cts" => {
                format!("{stem}.js")
            }
            "json" => format!("{artifact_path}.js"),
            _ => artifact_path.clone(),
        },
        None => format!("{artifact_path}.js"),
    };
    format!("__gsv_browser__/{emitted}")
}

fn build_browser_shell_html(browser_entry: &str, stylesheet_paths: &[String]) -> String {
    let stylesheet_links = stylesheet_paths
        .iter()
        .map(|path| {
            format!(
                r#"<link rel="stylesheet" href={} />"#,
                serde_json::to_string(&relative_specifier("index.html", path)).unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let entry_src =
        serde_json::to_string(&relative_specifier("index.html", browser_entry)).unwrap();
    if stylesheet_links.is_empty() {
        format!(
            "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n</head>\n<body>\n<div id=\"root\"></div>\n<script type=\"module\" src={entry_src}></script>\n</body>\n</html>\n"
        )
    } else {
        format!(
            "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n{stylesheet_links}\n</head>\n<body>\n<div id=\"root\"></div>\n<script type=\"module\" src={entry_src}></script>\n</body>\n</html>\n"
        )
    }
}

fn join_import_block(imports: &[String]) -> String {
    if imports.is_empty() {
        String::new()
    } else {
        format!("{}\n", imports.join("\n"))
    }
}

fn content_type_for_path(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    }
}
