use crate::diagnostics::{has_errors, PackageAssemblyDiagnostic};
use crate::graph::{build_module_graph_for_entry, ModuleGraph};
use crate::model::{
    PackageAssemblyAnalysis, PackageAssemblyArtifactModule, PackageAssemblyArtifactModuleKind,
};
use crate::npm::InstalledAssembly;
use crate::pipeline::StageOutcome;
use crate::virtual_fs::{relative_specifier, relativize_to_root, resolve_from_root};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAssembly {
    pub main_module: String,
    pub browser_graph: ModuleGraph,
    pub definition_graph: ModuleGraph,
    pub generated_modules: Vec<PackageAssemblyArtifactModule>,
}

pub fn build_runtime_assembly(
    analysis: &PackageAssemblyAnalysis,
    installed: &InstalledAssembly,
) -> StageOutcome<RuntimeAssembly> {
    let mut diagnostics = Vec::new();

    let Some(browser_entry) = installed.browser_entry.as_deref() else {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "runtime-wrapper.missing-handler",
            "Package app is missing a browser entry module.",
            "src/package.ts",
        ));
        return StageOutcome::failure(diagnostics);
    };

    let definition_repo_path = resolve_from_root(&analysis.package_root, "src/package.ts");
    if !installed.files.contains(&definition_repo_path) {
        diagnostics.push(PackageAssemblyDiagnostic::error(
            "contract.definition-source-missing",
            "Package definition source file src/package.ts is missing from the package snapshot.",
            definition_repo_path,
        ));
        return StageOutcome::failure(diagnostics);
    }

    let browser_graph = build_module_graph_for_entry(installed, browser_entry);
    diagnostics.extend(browser_graph.diagnostics);
    let Some(browser_graph) = browser_graph.value else {
        return StageOutcome::failure(diagnostics);
    };

    let definition_graph = build_module_graph_for_entry(installed, &definition_repo_path);
    diagnostics.extend(definition_graph.diagnostics);
    let Some(definition_graph) = definition_graph.value else {
        return StageOutcome::failure(diagnostics);
    };

    let generated_modules = generate_runtime_modules(
        analysis,
        installed,
        relativize_to_root(browser_entry, &analysis.package_root),
        relativize_to_root(&definition_repo_path, &analysis.package_root),
    );

    if has_errors(&diagnostics) {
        return StageOutcome::failure(diagnostics);
    }

    StageOutcome::success(
        RuntimeAssembly {
            main_module: "__gsv__/main.ts".to_string(),
            browser_graph,
            definition_graph,
            generated_modules,
        },
        diagnostics,
    )
}

fn generate_runtime_modules(
    analysis: &PackageAssemblyAnalysis,
    installed: &InstalledAssembly,
    browser_entry_artifact_path: String,
    definition_artifact_path: String,
) -> Vec<PackageAssemblyArtifactModule> {
    let mut modules = Vec::new();
    let mut asset_imports = Vec::new();
    let mut asset_entries = Vec::new();

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

    let asset_import_block = if asset_imports.is_empty() {
        String::new()
    } else {
        format!("{}\n", asset_imports.join("\n"))
    };

    let wrapper = format!(
        r#"{asset_import_block}import {{ RpcTarget, WorkerEntrypoint }} from "cloudflare:workers";
import definition from {definition_import};

const STATIC_META = Object.freeze({{
  packageName: {package_name},
  packageId: {package_id},
  routeBase: null,
}});
const BROWSER_ENTRY = {browser_entry};
const STATIC_ASSETS = new Map([
{asset_entries}
]);

function buildBaseContext() {{
  return {{
    meta: STATIC_META,
    viewer: {{ uid: 0, username: "" }},
    kernel: {{
      async request() {{
        throw new Error("kernel binding is unavailable");
      }},
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
    const routeBase = "/";
    const assetResponse = serveStaticAsset(request, routeBase);
    if (assetResponse) {{
      return assetResponse;
    }}
    const app = getAppDefinition();
    if (!app || typeof app.fetch !== "function") {{
      return new Response("Not Found", {{ status: 404 }});
    }}
    return app.fetch(request, buildBaseContext());
  }}
}}

class GsvPackageAppBackend extends RpcTarget {{
  constructor() {{
    super();
    this.__gsvCtx = buildBaseContext();
    this.__gsvApp = getAppDefinition();
  }}

  async __invoke(method, args) {{
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
    return new GsvPackageAppBackend();
  }}
}}
"#,
        definition_import = serde_json::to_string(&relative_specifier(
            "__gsv__/main.ts",
            &definition_artifact_path
        ))
        .unwrap(),
        package_name = serde_json::to_string(&analysis.package_json.name).unwrap(),
        package_id = serde_json::to_string(&analysis.package_json.name).unwrap(),
        browser_entry = serde_json::to_string(&browser_entry_artifact_path).unwrap(),
        asset_entries = asset_entries.join("\n"),
    );

    modules.push(PackageAssemblyArtifactModule {
        path: "__gsv__/main.ts".to_string(),
        kind: PackageAssemblyArtifactModuleKind::SourceModule,
        content: wrapper,
    });
    modules
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
