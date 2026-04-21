import { createWorker } from "@cloudflare/worker-bundler";
import { WorkerEntrypoint } from "cloudflare:workers";
import { transform } from "sucrase";
import type {
  PackageAssemblerInterface,
  PackageAssemblyAnalysis,
  PackageAssemblyArtifact,
  PackageAssemblyArtifactModule,
  PackageAssemblyDiagnostic,
  PackageAssemblyRequest,
  PackageAssemblyResponse,
} from "@gsv/protocol/package-assembly";
import {
  GSV_APP_LINK_FALLBACK_FILES,
  GSV_APP_LINK_NAME,
  GSV_PACKAGE_SDK_FALLBACK_FILES,
  GSV_PACKAGE_SDK_NAME,
} from "./sdk-fallback";

type WorkerLoaderModuleLike =
  | string
  | {
      js?: string;
      cjs?: string;
      text?: string;
      json?: unknown;
      data?: ArrayBuffer | ArrayBufferView;
    };

interface Env {}

const DEFAULT_COMPATIBILITY_DATE = "2026-01-28";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
    return new Response("Not Found", { status: 404 });
  },
};

export class PackageAssembler extends WorkerEntrypoint<Env> implements PackageAssemblerInterface {
  async assemblePackage(input: PackageAssemblyRequest): Promise<PackageAssemblyResponse> {
    const diagnostics: PackageAssemblyDiagnostic[] = [];

    try {
      if (!input.analysis.ok || !input.analysis.definition) {
        return {
          source: input.analysis.source,
          analysis_hash: input.analysis.analysis_hash,
          target: input.target,
          diagnostics: [
            ...input.analysis.diagnostics,
            {
              severity: "error",
              code: "package-analysis-invalid",
              message: "package assembly requires a successful analysis result",
              path: input.analysis.source.subdir,
              line: 1,
              column: 1,
            },
          ],
          ok: false,
        };
      }

      diagnostics.push(...input.analysis.diagnostics);

      const bundlerFiles = prepareBundlerProjectFiles(input.analysis, input.files);
      const publicAssets = await buildPublicAssets(input.analysis, bundlerFiles, diagnostics);
      const runtimeFiles = buildRuntimeFiles(input.analysis, bundlerFiles, publicAssets);
      const runtimeBundle = await createWorker({
        files: runtimeFiles,
        entryPoint: "__gsv__/main.ts",
        bundle: true,
      });

      for (const warning of runtimeBundle.warnings ?? []) {
        diagnostics.push(makeWarning("runtime-bundle-warning", warning, input.analysis.source.subdir));
      }

      const passthroughModules = collectPassthroughArtifactModules(input.analysis, bundlerFiles);
      const artifact = await toArtifact(runtimeBundle.mainModule, runtimeBundle.modules, passthroughModules);
      return {
        source: input.analysis.source,
        analysis_hash: input.analysis.analysis_hash,
        target: input.target,
        artifact,
        diagnostics,
        ok: !diagnostics.some((entry) => entry.severity === "error"),
      };
    } catch (error) {
      diagnostics.push(makeError("package-assembly-failed", error, input.analysis.source.subdir));
      return {
        source: input.analysis.source,
        analysis_hash: input.analysis.analysis_hash,
        target: input.target,
        diagnostics,
        ok: false,
      };
    }
  }
}

type PublicAsset = {
  path: string;
  content: string;
  contentType: string;
};

async function buildPublicAssets(
  analysis: PackageAssemblyAnalysis,
  repoFiles: Record<string, string>,
  diagnostics: PackageAssemblyDiagnostic[],
): Promise<PublicAsset[]> {
  const app = analysis.definition?.app;
  if (!app?.browser_entry) {
    return [];
  }

  const packageRoot = normalizePath(analysis.source.subdir);
  const entryRelPath = normalizePath(app.browser_entry.replace(/^\.\//, ""));
  const entryRepoPath = joinPosix(packageRoot, entryRelPath);
  const entryHtml = repoFiles[entryRepoPath];
  if (typeof entryHtml !== "string") {
    diagnostics.push({
      severity: "error",
      code: "missing-browser-entry",
      message: `missing browser entry asset: ${app.browser_entry}`,
      path: entryRepoPath,
      line: 1,
      column: 1,
    });
    return [];
  }

  const scriptSpecifiers = extractHtmlModuleScriptSpecifiers(entryHtml);
  let rewrittenHtml = entryHtml;
  const assets: PublicAsset[] = [];

  for (const [index, specifier] of scriptSpecifiers.entries()) {
    const repoPath = resolveAssetSpecifier(entryRepoPath, specifier);
    const bundle = await createWorker({
      files: repoFiles,
      entryPoint: repoPath,
      bundle: true,
    });
    for (const warning of bundle.warnings ?? []) {
      diagnostics.push(makeWarning("browser-bundle-warning", warning, repoPath));
    }

    const prefix = `__gsv_browser__/${index}`;
    const moduleAssets = workerModulesToAssets(prefix, bundle.mainModule, bundle.modules);
    assets.push(...moduleAssets.assets);
    rewrittenHtml = rewrittenHtml.replace(
      specifier,
      relativeAssetSpecifier(entryRelPath, moduleAssets.mainAssetPath),
    );
  }

  assets.push({
    path: entryRelPath,
    content: rewrittenHtml,
    contentType: contentTypeForPath(entryRelPath),
  });

  const declaredAssets = new Set<string>();
  for (const assetPath of app.assets ?? []) {
    const relPath = normalizePath(assetPath.replace(/^\.\//, ""));
    if (!relPath || declaredAssets.has(relPath)) {
      continue;
    }
    declaredAssets.add(relPath);
    const repoPath = joinPosix(packageRoot, relPath);
    const content = repoFiles[repoPath];
    if (typeof content !== "string") {
      diagnostics.push({
        severity: "error",
        code: "missing-app-asset",
        message: `missing app asset: ${relPath}`,
        path: repoPath,
        line: 1,
        column: 1,
      });
      continue;
    }
    assets.push({
      path: relPath,
      content,
      contentType: contentTypeForPath(relPath),
    });
  }

  return dedupeAssets(assets);
}

function buildRuntimeFiles(
  analysis: PackageAssemblyAnalysis,
  bundlerFiles: Record<string, string>,
  publicAssets: PublicAsset[],
): Record<string, string> {
  const files: Record<string, string> = {
    ...bundlerFiles,
  };

  const assetImports: Array<{
    importName: string;
    importPath: string;
    assetPath: string;
    contentType: string;
  }> = [];

  for (const [index, asset] of publicAssets.entries()) {
    const generatedPath = `__gsv_assets__/${index}${extensionForAssetPath(asset.path)}.ts`;
    files[generatedPath] = `export default ${JSON.stringify(asset.content)};\n`;
    assetImports.push({
      importName: `__gsv_asset_${index}`,
      importPath: relativeAssetSpecifier("__gsv__/main.ts", generatedPath),
      assetPath: asset.path,
      contentType: asset.contentType,
    });
  }

  files["__gsv__/main.ts"] = generateDynamicWorkerMainModule(analysis, assetImports);
  return files;
}

function prepareBundlerProjectFiles(
  analysis: PackageAssemblyAnalysis,
  repoFiles: Record<string, string>,
): Record<string, string> {
  const files = {
    ...repoFiles,
  };
  injectBuiltinSdkFiles(files);
  const transformedFiles = applyConfiguredJsxTransforms(files);
  const workspacePackages = collectWorkspacePackages(transformedFiles);
  const rootPackage: WorkspacePackage = {
    root: normalizePath(analysis.package_root),
    manifest: {
      name: analysis.package_json.name,
      version: analysis.package_json.version ?? null,
      type: analysis.package_json.type ?? null,
      dependencies: analysis.package_json.dependencies ?? {},
      devDependencies: analysis.package_json.dev_dependencies ?? {},
    },
    lockedDependencies: collectLockedDependencyVersions(
      transformedFiles,
      normalizePath(analysis.package_root),
    ),
  };
  materializeWorkspacePackages(transformedFiles, workspacePackages, analysis.package_json.name);

  transformedFiles["package.json"] = JSON.stringify({
    name: analysis.package_json.name,
    version: analysis.package_json.version ?? "0.0.0",
    type: analysis.package_json.type ?? "module",
    dependencies: collectBundlerDependencies(rootPackage, workspacePackages),
  }, null, 2);

  return transformedFiles;
}

type WorkspacePackageManifest = {
  name: string;
  version?: string | null;
  type?: string | null;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type WorkspacePackage = {
  root: string;
  manifest: WorkspacePackageManifest;
  lockedDependencies: Record<string, string>;
};

type PackageLockFile = {
  packages?: Record<string, { version?: string | null }>;
  dependencies?: Record<string, { version?: string | null }>;
};

type JsxCompilerSettings = {
  runtime?: "automatic" | "classic";
  importSource?: string;
  factory?: string;
  fragmentFactory?: string;
};

type BuildConfigFile = {
  extends?: string;
  compilerOptions?: {
    jsx?: string;
    jsxImportSource?: string;
    jsxFactory?: string;
    jsxFragmentFactory?: string;
  };
};

function collectBundlerDependencies(
  rootPackage: WorkspacePackage,
  workspacePackages: Map<string, WorkspacePackage>,
): Record<string, string> {
  const rewritten: Record<string, string> = {};

  const packages: WorkspacePackage[] = [
    rootPackage,
    ...Array.from(workspacePackages.values()),
  ];
  const localPackageNames = new Set(
    packages
      .map((pkg) => pkg.manifest.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  for (const pkg of packages) {
    for (const [name, spec] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (
        typeof spec !== "string"
        || name in rewritten
        || isLocalDependencySpec(name, spec, localPackageNames)
      ) {
        continue;
      }
      rewritten[name] = pkg.lockedDependencies[name] ?? spec;
    }
  }

  return rewritten;
}

function isLocalDependencySpec(
  packageName: string,
  spec: string,
  localPackageNames: ReadonlySet<string>,
): boolean {
  return (
    localPackageNames.has(packageName)
    || spec.startsWith("file:")
    || spec.startsWith("link:")
    || spec.startsWith("workspace:")
  );
}

function collectWorkspacePackages(files: Record<string, string>): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();

  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith("/package.json") || path.startsWith("node_modules/")) {
      continue;
    }

    let manifest: WorkspacePackageManifest;
    try {
      manifest = JSON.parse(content) as WorkspacePackageManifest;
    } catch {
      continue;
    }

    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      continue;
    }

    packages.set(manifest.name, {
      root: dirname(path),
      manifest,
      lockedDependencies: collectLockedDependencyVersions(files, dirname(path)),
    });
  }

  return packages;
}

function injectBuiltinSdkFiles(files: Record<string, string>): void {
  if (!repoDeclaresPackage(files, GSV_APP_LINK_NAME)) {
    for (const [path, content] of Object.entries(GSV_APP_LINK_FALLBACK_FILES)) {
      files[path] ??= content;
    }
  }

  if (!repoDeclaresPackage(files, GSV_PACKAGE_SDK_NAME)) {
    for (const [path, content] of Object.entries(GSV_PACKAGE_SDK_FALLBACK_FILES)) {
      files[path] ??= content;
    }
  }
}

function repoDeclaresPackage(files: Record<string, string>, packageName: string): boolean {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith("/package.json") && path !== "package.json") {
      continue;
    }

    let manifest: WorkspacePackageManifest;
    try {
      manifest = JSON.parse(content) as WorkspacePackageManifest;
    } catch {
      continue;
    }

    if (manifest.name === packageName) {
      return true;
    }
  }

  return false;
}

function collectLockedDependencyVersions(
  files: Record<string, string>,
  packageRoot: string,
): Record<string, string> {
  const lockfilePath = packageRoot ? joinPosix(packageRoot, "package-lock.json") : "package-lock.json";
  const source = files[lockfilePath];
  if (typeof source !== "string" || source.trim().length === 0) {
    return {};
  }

  let parsed: PackageLockFile;
  try {
    parsed = JSON.parse(source) as PackageLockFile;
  } catch {
    return {};
  }

  const locked: Record<string, string> = {};
  for (const [entryPath, entry] of Object.entries(parsed.packages ?? {})) {
    const packageName = topLevelNodeModulesPackageName(entryPath);
    const version = normalizeString(entry?.version);
    if (!packageName || !version) {
      continue;
    }
    locked[packageName] = version;
  }

  for (const [packageName, entry] of Object.entries(parsed.dependencies ?? {})) {
    const version = normalizeString(entry?.version);
    if (!version || packageName in locked) {
      continue;
    }
    locked[packageName] = version;
  }

  return locked;
}

function topLevelNodeModulesPackageName(path: string): string | null {
  if (!path.startsWith("node_modules/")) {
    return null;
  }

  const relative = path.slice("node_modules/".length);
  const segments = relative.split("/").filter(Boolean);
  if (segments.length === 1) {
    return segments[0];
  }
  if (segments[0]?.startsWith("@") && segments.length === 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return null;
}

function materializeWorkspacePackages(
  files: Record<string, string>,
  workspacePackages: Map<string, WorkspacePackage>,
  rootPackageName: string,
): void {
  for (const [packageName, pkg] of workspacePackages.entries()) {
    if (packageName === rootPackageName) {
      continue;
    }

    const rootPrefix = `${pkg.root}/`;
    const materializedRoot = joinPosix("node_modules", packageName);
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(rootPrefix)) {
        continue;
      }

      const relativePath = path.slice(rootPrefix.length);
      files[joinPosix(materializedRoot, relativePath)] = content;
    }

    files[joinPosix(materializedRoot, "package.json")] = JSON.stringify(pkg.manifest, null, 2);
  }
}

function applyConfiguredJsxTransforms(files: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  const configCache = new Map<string, JsxCompilerSettings | null>();

  for (const [path, content] of Object.entries(files)) {
    if (!/\.(tsx|jsx)$/i.test(path)) {
      next[path] = content;
      continue;
    }

    const settings = resolveJsxCompilerSettings(path, files, configCache);
    next[path] = transformJsxModule(path, content, settings);
  }

  return next;
}

function transformJsxModule(
  path: string,
  source: string,
  settings: JsxCompilerSettings | null,
): string {
  if (!settings) {
    return source;
  }

  const runtime = settings.runtime ?? (settings.factory || settings.fragmentFactory ? "classic" : undefined);
  if (!runtime) {
    return source;
  }

  const transforms: Array<"jsx" | "typescript"> = ["jsx"];
  if (path.endsWith(".tsx")) {
    transforms.unshift("typescript");
  }

  return transform(source, {
    filePath: path,
    transforms,
    jsxRuntime: runtime,
    jsxImportSource: settings.importSource,
    jsxPragma: settings.factory,
    jsxFragmentPragma: settings.fragmentFactory,
    production: true,
    preserveDynamicImport: true,
    disableESTransforms: true,
  }).code;
}

function resolveJsxCompilerSettings(
  sourcePath: string,
  files: Record<string, string>,
  cache: Map<string, JsxCompilerSettings | null>,
): JsxCompilerSettings | null {
  const configPath = findNearestBuildConfigPath(sourcePath, files);
  if (!configPath) {
    return null;
  }
  return loadJsxCompilerSettings(configPath, files, cache);
}

function findNearestBuildConfigPath(sourcePath: string, files: Record<string, string>): string | null {
  let current = dirname(sourcePath);
  while (true) {
    for (const configName of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = current ? joinPosix(current, configName) : configName;
      if (candidate in files) {
        return candidate;
      }
    }
    if (!current) {
      return null;
    }
    current = dirname(current);
  }
}

function loadJsxCompilerSettings(
  configPath: string,
  files: Record<string, string>,
  cache: Map<string, JsxCompilerSettings | null>,
): JsxCompilerSettings | null {
  if (cache.has(configPath)) {
    return cache.get(configPath) ?? null;
  }

  const parsed = parseBuildConfigFile(files[configPath]);
  if (!parsed) {
    cache.set(configPath, null);
    return null;
  }

  const base = resolveExtendedJsxCompilerSettings(configPath, parsed.extends, files, cache);
  const merged = mergeJsxCompilerSettings(base, normalizeJsxCompilerSettings(parsed.compilerOptions));
  cache.set(configPath, merged);
  return merged;
}

function resolveExtendedJsxCompilerSettings(
  configPath: string,
  extendsPath: string | undefined,
  files: Record<string, string>,
  cache: Map<string, JsxCompilerSettings | null>,
): JsxCompilerSettings | null {
  if (typeof extendsPath !== "string" || extendsPath.trim().length === 0) {
    return null;
  }
  const resolved = resolveExtendedConfigPath(configPath, extendsPath);
  if (!resolved || !(resolved in files)) {
    return null;
  }
  return loadJsxCompilerSettings(resolved, files, cache);
}

function resolveExtendedConfigPath(configPath: string, extendsPath: string): string | null {
  if (!extendsPath.startsWith(".") && !extendsPath.startsWith("/")) {
    return null;
  }
  const candidate = normalizePath(joinPosix(dirname(configPath), extendsPath));
  const withJson = candidate.endsWith(".json") ? candidate : `${candidate}.json`;
  return withJson;
}

function mergeJsxCompilerSettings(
  base: JsxCompilerSettings | null,
  override: JsxCompilerSettings | null,
): JsxCompilerSettings | null {
  if (!base && !override) {
    return null;
  }
  return {
    runtime: override?.runtime ?? base?.runtime,
    importSource: override?.importSource ?? base?.importSource,
    factory: override?.factory ?? base?.factory,
    fragmentFactory: override?.fragmentFactory ?? base?.fragmentFactory,
  };
}

function normalizeJsxCompilerSettings(
  compilerOptions: BuildConfigFile["compilerOptions"] | undefined,
): JsxCompilerSettings | null {
  if (!compilerOptions) {
    return null;
  }

  const jsx = normalizeString(compilerOptions.jsx)?.toLowerCase();
  const importSource = normalizeString(compilerOptions.jsxImportSource);
  const factory = normalizeString(compilerOptions.jsxFactory);
  const fragmentFactory = normalizeString(compilerOptions.jsxFragmentFactory);

  let runtime: JsxCompilerSettings["runtime"];
  if (jsx === "react-jsx" || jsx === "react-jsxdev") {
    runtime = "automatic";
  } else if (jsx === "react") {
    runtime = "classic";
  }

  if (!runtime && !importSource && !factory && !fragmentFactory) {
    return null;
  }

  return {
    runtime,
    importSource,
    factory,
    fragmentFactory,
  };
}

function parseBuildConfigFile(source: string | undefined): BuildConfigFile | null {
  if (typeof source !== "string" || source.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(stripJsonComments(source)) as BuildConfigFile;
  } catch {
    return null;
  }
}

function stripJsonComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function normalizeString(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function generateDynamicWorkerMainModule(
  analysis: PackageAssemblyAnalysis,
  assets: Array<{
    importName: string;
    importPath: string;
    assetPath: string;
    contentType: string;
  }>,
): string {
  const assetImports = assets
    .map((asset) => `import ${asset.importName} from ${JSON.stringify(asset.importPath)};`)
    .join("\n");
  const assetEntries = assets
    .map((asset) =>
      `  [${JSON.stringify(asset.assetPath)}, { content: ${asset.importName}, contentType: ${JSON.stringify(asset.contentType)} }],`
    )
    .join("\n");
  const packageId = analysis.package_json.name;
  const browserEntry = analysis.definition?.app?.browser_entry
    ? normalizePath(analysis.definition.app.browser_entry.replace(/^\.\//, ""))
    : null;
  const appRpcMethods = (analysis.definition?.app?.rpc_methods ?? [])
    .map((name) =>
      `  async [${JSON.stringify(name)}](args) {\n    return this.__invoke(${JSON.stringify(name)}, args);\n  }\n`
    )
    .join("");
  const definitionImport = relativeAssetSpecifier(
    "__gsv__/main.ts",
    joinPosix(analysis.source.subdir, "src/package.ts"),
  );

  return `${assetImports ? `${assetImports}\n` : ""}import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import definition from ${JSON.stringify(definitionImport)};

const STATIC_META = Object.freeze({
  packageName: ${JSON.stringify(analysis.package_json.name)},
  packageId: ${JSON.stringify(packageId)},
  routeBase: null,
});
const BROWSER_ENTRY = ${browserEntry ? JSON.stringify(browserEntry) : "null"};
const STATIC_ASSETS = new Map([
${assetEntries}
]);

let setupPromise = null;
const LIVE_SIGNAL_WATCH_TTL_MS = 24 * 60 * 60 * 1000;

function mergeMeta(overrides) {
  if (!overrides) {
    return STATIC_META;
  }
  return {
    ...STATIC_META,
    ...overrides,
  };
}

function resolveAppFrame(env, props) {
  const frame = props?.appFrame && typeof props.appFrame === "object"
    ? props.appFrame
    : (env.GSV_APP_FRAME && typeof env.GSV_APP_FRAME === "object" ? env.GSV_APP_FRAME : null);
  return frame && typeof frame === "object"
    ? {
        uid: typeof frame.uid === "number" ? frame.uid : 0,
        username: typeof frame.username === "string" ? frame.username : "",
        packageId: typeof frame.packageId === "string" ? frame.packageId : (env.GSV_PACKAGE_ID ?? STATIC_META.packageId),
        packageName: typeof frame.packageName === "string" ? frame.packageName : (env.GSV_PACKAGE_NAME ?? STATIC_META.packageName),
        entrypointName: typeof frame.entrypointName === "string" ? frame.entrypointName : "",
        routeBase: typeof frame.routeBase === "string" ? frame.routeBase : (env.GSV_ROUTE_BASE ?? STATIC_META.routeBase),
        issuedAt: typeof frame.issuedAt === "number" ? frame.issuedAt : Date.now(),
        expiresAt: typeof frame.expiresAt === "number" ? frame.expiresAt : (Date.now() + 365 * 24 * 60 * 60 * 1000),
      }
    : null;
}

function buildKernelClient(env, props, kernelOverride) {
  if (kernelOverride && typeof kernelOverride.request === "function") {
    return kernelOverride;
  }
  if (props?.kernel && typeof props.kernel.request === "function") {
    return props.kernel;
  }
  if (env.KERNEL && typeof env.KERNEL.request === "function") {
    return env.KERNEL;
  }
  return {
    async request() {
      throw new Error("kernel binding is unavailable");
    },
  };
}

function createBaseContext(env, metaOverrides, props, kernelOverride) {
  return {
    meta: mergeMeta(metaOverrides),
    viewer: props?.appFrame && typeof props.appFrame === "object"
      ? {
          uid: typeof props.appFrame.uid === "number" ? props.appFrame.uid : 0,
          username: typeof props.appFrame.username === "string" ? props.appFrame.username : "",
        }
      : { uid: 0, username: "" },
    app: props?.appSession && typeof props.appSession === "object"
      ? {
          sessionId: typeof props.appSession.sessionId === "string" ? props.appSession.sessionId : "",
          clientId: typeof props.appSession.clientId === "string" ? props.appSession.clientId : "",
          rpcBase: typeof props.appSession.rpcBase === "string" ? props.appSession.rpcBase : "",
          expiresAt: typeof props.appSession.expiresAt === "number" ? props.appSession.expiresAt : 0,
        }
      : undefined,
    kernel: buildKernelClient(env, props, kernelOverride),
  };
}

async function ensureSetup(ctx) {
  if (typeof definition.setup !== "function") {
    return;
  }
  if (!setupPromise) {
    setupPromise = Promise.resolve(definition.setup(ctx));
  }
  await setupPromise;
}

function noOpStdin() {
  return {
    async text() {
      return "";
    },
  };
}

function normalizeTrigger(trigger) {
  if (!trigger || typeof trigger !== "object") {
    return { kind: "manual" };
  }
  return {
    kind: typeof trigger.kind === "string" ? trigger.kind : "manual",
    scheduledAt: typeof trigger.scheduledAt === "number" ? trigger.scheduledAt : undefined,
  };
}

function getAppDefinition() {
  const app = definition && definition.app;
  if (!app || typeof app !== "object") {
    return null;
  }
  return app;
}

function getAppRpcHandler(app, method) {
  if (!app || !app.rpc || typeof app.rpc !== "object") {
    return null;
  }
  const handler = app.rpc[method];
  if (typeof handler !== "function") {
    return null;
  }
  return handler;
}

function deserializeHttpRequest(input) {
  const headers = new Headers(Array.isArray(input?.headers) ? input.headers : []);
  const init = {
    method: typeof input?.method === "string" ? input.method : "GET",
    headers,
  };
  if (input?.body instanceof ArrayBuffer) {
    init.body = input.body;
  }
  return new Request(typeof input?.url === "string" ? input.url : "http://localhost/", init);
}

async function serializeHttpResponse(response) {
  const headers = Array.from(response.headers.entries());
  const body = response.body ? await response.arrayBuffer() : null;
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
  };
}

function serveStaticAsset(request, routeBase) {
  if (!BROWSER_ENTRY) {
    return null;
  }
  const url = new URL(request.url);
  if (url.pathname === routeBase) {
    const canonicalUrl = new URL(\`\${routeBase}/\`, url.origin);
    canonicalUrl.search = url.search;
    return Response.redirect(canonicalUrl.toString(), 302);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }
  let assetPath = null;
  if (url.pathname === \`\${routeBase}/\` || url.pathname === \`\${routeBase}/index.html\`) {
    assetPath = BROWSER_ENTRY;
  } else if (url.pathname.startsWith(\`\${routeBase}/\`)) {
    assetPath = url.pathname.slice(routeBase.length + 1);
  }
  if (!assetPath) {
    return null;
  }
  const asset = STATIC_ASSETS.get(assetPath);
  if (!asset) {
    return null;
  }
  return new Response(request.method === "HEAD" ? null : asset.content, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "no-store",
    },
  });
}

function requireNamedHandler(groupName, handlerName) {
  const group = definition && definition[groupName];
  if (!group || typeof group !== "object") {
    throw new Error(\`package has no \${groupName} handlers\`);
  }
  const handler = group[handlerName];
  if (typeof handler !== "function") {
    throw new Error(\`unknown package \${groupName} handler: \${handlerName}\`);
  }
  return handler;
}

export default class GsvAppEntrypoint extends WorkerEntrypoint {
  async fetch(request) {
    const app = getAppDefinition();
    if (!app) {
      return new Response("Not Found", { status: 404 });
    }
    const props = this.ctx.props ?? {};
    const ctx = createBaseContext(this.env, {
      packageId: props.appFrame?.packageId ?? props.packageId ?? this.env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: props.appFrame?.routeBase ?? props.routeBase ?? this.env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    }, props);
    const routeBase = ctx.meta.routeBase ?? "/";
    const assetResponse = serveStaticAsset(request, routeBase);
    if (assetResponse) {
      return assetResponse;
    }
    if (typeof app.fetch !== "function") {
      return new Response("Not Found", { status: 404 });
    }
    await ensureSetup(ctx);
    return app.fetch(request, ctx);
  }
}

export class GsvCommandEntrypoint extends WorkerEntrypoint {
  async run(input) {
    const props = this.ctx.props ?? {};
    const resolvedCommandName =
      typeof input === "string" && input.length > 0
        ? input
        : props.commandName;
    if (typeof resolvedCommandName !== "string" || resolvedCommandName.length === 0) {
      throw new Error("package command name is required");
    }
    const commandInput = input && typeof input === "object" ? input : {};
    const stdoutChunks = [];
    const stderrChunks = [];
    const ctx = {
      ...createBaseContext(this.env, {
        packageId: props.packageId ?? this.env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
        routeBase: props.routeBase ?? this.env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
      }, props),
      argv: Array.isArray(commandInput.args)
        ? commandInput.args
        : (Array.isArray(props.argv) ? props.argv : []),
      stdin: typeof commandInput.stdin === "string"
        ? {
            async text() {
              return commandInput.stdin;
            },
          }
        : (props.stdin ?? noOpStdin()),
      stdout: props.stdout ?? {
        async write(value) {
          stdoutChunks.push(String(value ?? ""));
        },
      },
      stderr: props.stderr ?? {
        async write(value) {
          stderrChunks.push(String(value ?? ""));
        },
      },
    };
    await ensureSetup(ctx);
    const handler = requireNamedHandler("commands", resolvedCommandName);
    await handler(ctx);
    return {
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      exitCode: 0,
    };
  }
}

export class GsvTaskEntrypoint extends WorkerEntrypoint {
  async run(taskName) {
    const props = this.ctx.props ?? {};
    const resolvedTaskName =
      typeof taskName === "string" && taskName.length > 0
        ? taskName
        : props.taskName;
    if (typeof resolvedTaskName !== "string" || resolvedTaskName.length === 0) {
      throw new Error("package task name is required");
    }
    const ctx = {
      ...createBaseContext(this.env, {
        packageId: props.packageId ?? STATIC_META.packageId,
        routeBase: props.routeBase ?? STATIC_META.routeBase,
      }),
      taskName: resolvedTaskName,
      trigger: normalizeTrigger(props.trigger),
      payload: props.payload,
    };
    await ensureSetup(ctx);
    const handler = requireNamedHandler("tasks", resolvedTaskName);
    return handler(ctx);
  }
}

export class GsvAppSignalEntrypoint extends WorkerEntrypoint {
  async run(signalName) {
    const props = this.ctx.props ?? {};
    const app = getAppDefinition();
    if (!app || typeof app.onSignal !== "function") {
      throw new Error("package app has no onSignal handler");
    }
    const resolvedSignalName =
      typeof signalName === "string" && signalName.length > 0
        ? signalName
        : props.signal;
    if (typeof resolvedSignalName !== "string" || resolvedSignalName.length === 0) {
      throw new Error("package signal name is required");
    }
    const ctx = {
      ...createBaseContext(this.env, {
        packageId: props.appFrame?.packageId ?? props.packageId ?? STATIC_META.packageId,
        routeBase: props.appFrame?.routeBase ?? props.routeBase ?? STATIC_META.routeBase,
      }, props),
      signal: resolvedSignalName,
      payload: props.payload,
      sourcePid: typeof props.sourcePid === "string" ? props.sourcePid : undefined,
      watch: props.watch && typeof props.watch === "object"
        ? {
            id: typeof props.watch.id === "string" ? props.watch.id : "",
            key: typeof props.watch.key === "string" ? props.watch.key : undefined,
            state: props.watch.state,
            createdAt: typeof props.watch.createdAt === "number" ? props.watch.createdAt : undefined,
          }
        : { id: "" },
    };
    await ensureSetup(ctx);
    return app.onSignal(ctx);
  }
}

export class GsvAppFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const app = getAppDefinition();
    if (!app) {
      throw new Error("package has no app definition");
    }
    this.__gsvApp = app;
    this.__gsvMeta = {
      packageId: env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    };
    this.__gsvSignalSubscriptions = new Map();
    this.__gsvSignalWatchRefs = new Map();
  }

  __context(runtime, kernel) {
    const appFrame = runtime?.appFrame ?? resolveAppFrame(this.env, {});
    return createBaseContext(this.env, {
      packageId: appFrame?.packageId ?? this.__gsvMeta.packageId,
      routeBase: appFrame?.routeBase ?? this.__gsvMeta.routeBase,
    }, {
      ...(appFrame ? { appFrame } : {}),
      ...(runtime?.appSession ? { appSession: runtime.appSession } : {}),
    }, kernel);
  }

  async __invoke(method, args, runtime, kernel) {
    const ctx = this.__context(runtime, kernel);
    await ensureSetup(ctx);
    const handler = getAppRpcHandler(this.__gsvApp, method);
    if (!handler) {
      throw new Error(\`Unknown app RPC method: \${method}\`);
    }
    return handler(args, ctx);
  }

  __watchKey(signal, processId) {
    return \`__gsv_live__:\${signal}:\${processId ?? "*"}\`;
  }

  async gsvSubscribeSignal(args, runtime, kernel) {
    const ctx = this.__context(runtime, kernel);
    await ensureSetup(ctx);
    const signals = Array.isArray(args?.signals)
      ? Array.from(new Set(args.signals.filter((value) => typeof value === "string" && value.length > 0)))
      : [];
    if (signals.length === 0) {
      throw new Error("signals are required");
    }
    const processId =
      typeof args?.processId === "string" && args.processId.length > 0
        ? args.processId
        : undefined;
    const sink = args?.sink;
    if (!sink || typeof sink.onSignal !== "function") {
      throw new Error("signal sink must implement onSignal()");
    }

    const subscriptionId = crypto.randomUUID();
    const watchKeys = [];
    for (const signal of signals) {
      const watchKey = this.__watchKey(signal, processId ?? null);
      let bucket = this.__gsvSignalWatchRefs.get(watchKey);
      if (!bucket) {
        await ctx.kernel.request("signal.watch", {
          signal,
          ...(processId ? { processId } : {}),
          key: watchKey,
          once: false,
          ttlMs: LIVE_SIGNAL_WATCH_TTL_MS,
          state: {
            source: "gsv-live-subscription",
            signal,
            processId: processId ?? null,
          },
        });
        bucket = {
          signal,
          processId: processId ?? null,
          subscribers: new Map(),
        };
        this.__gsvSignalWatchRefs.set(watchKey, bucket);
      }
      bucket.subscribers.set(subscriptionId, sink);
      watchKeys.push(watchKey);
    }

    this.__gsvSignalSubscriptions.set(subscriptionId, watchKeys);
    return { subscriptionId };
  }

  async gsvUnsubscribeSignal(args, runtime, kernel) {
    const ctx = this.__context(runtime, kernel);
    const subscriptionId =
      typeof args?.subscriptionId === "string" && args.subscriptionId.length > 0
        ? args.subscriptionId
        : "";
    if (!subscriptionId) {
      return { removed: false };
    }
    const watchKeys = this.__gsvSignalSubscriptions.get(subscriptionId);
    if (!watchKeys) {
      return { removed: false };
    }
    this.__gsvSignalSubscriptions.delete(subscriptionId);
    for (const watchKey of watchKeys) {
      const bucket = this.__gsvSignalWatchRefs.get(watchKey);
      if (!bucket) {
        continue;
      }
      bucket.subscribers.delete(subscriptionId);
      if (bucket.subscribers.size > 0) {
        continue;
      }
      this.__gsvSignalWatchRefs.delete(watchKey);
      await ctx.kernel.request("signal.unwatch", { key: watchKey }).catch(() => {});
    }
    return { removed: true };
  }

  async gsvHandleSignal(signalName, payload, sourcePid, watch, runtime, kernel) {
    const ctx = this.__context(runtime, kernel);
    await ensureSetup(ctx);

    if (typeof this.__gsvApp.onSignal === "function") {
      await this.__gsvApp.onSignal({
        ...ctx,
        signal: signalName,
        payload,
        sourcePid: typeof sourcePid === "string" ? sourcePid : undefined,
        watch: watch && typeof watch === "object"
          ? {
              id: typeof watch.id === "string" ? watch.id : "",
              key: typeof watch.key === "string" ? watch.key : undefined,
              state: watch.state,
              createdAt: typeof watch.createdAt === "number" ? watch.createdAt : undefined,
            }
          : { id: "" },
      });
    }

    const watchKey = watch && typeof watch.key === "string"
      ? watch.key
      : this.__watchKey(
          signalName,
          watch && watch.state && typeof watch.state.processId === "string"
            ? watch.state.processId
            : null,
        );
    const bucket = this.__gsvSignalWatchRefs.get(watchKey);
    if (!bucket || bucket.subscribers.size === 0) {
      return;
    }

    const stale = [];
    await Promise.all(Array.from(bucket.subscribers.entries()).map(async ([subscriptionId, sink]) => {
      try {
        await sink.onSignal(signalName, {
          payload,
          sourcePid: typeof sourcePid === "string" ? sourcePid : null,
          watch,
        });
      } catch {
        stale.push(subscriptionId);
      }
    }));

    for (const subscriptionId of stale) {
      bucket.subscribers.delete(subscriptionId);
      this.__gsvSignalSubscriptions.delete(subscriptionId);
    }
  }

  async gsvFetch(input, runtime, kernel) {
    const request = deserializeHttpRequest(input);
    const ctx = this.__context(runtime, kernel);
    const app = this.__gsvApp;
    if (!app) {
      return serializeHttpResponse(new Response("Not Found", { status: 404 }));
    }
    const routeBase = ctx.meta.routeBase ?? "/";
    const assetResponse = serveStaticAsset(request, routeBase);
    if (assetResponse) {
      return serializeHttpResponse(assetResponse);
    }
    if (typeof app.fetch !== "function") {
      return serializeHttpResponse(new Response("Not Found", { status: 404 }));
    }
    await ensureSetup(ctx);
    return serializeHttpResponse(await app.fetch(request, ctx));
  }

  async fetch(request) {
    const result = await this.gsvFetch({
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      body: request.body ? await request.arrayBuffer() : null,
    }, undefined, undefined);
    return new Response(result.body ?? null, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  async gsvInvoke(method, args, runtime, kernel) {
    return this.__invoke(method, args, runtime, kernel);
  }

${appRpcMethods}}

class GsvPackageAppBackend extends RpcTarget {
  constructor(env, props) {
    super();
    const app = getAppDefinition();
    if (!app || !app.rpc || typeof app.rpc !== "object") {
      throw new Error("package app has no rpc handlers");
    }
    const ctx = createBaseContext(env, {
      packageId: props.appFrame?.packageId ?? props.packageId ?? env.GSV_PACKAGE_ID ?? STATIC_META.packageId,
      routeBase: props.appFrame?.routeBase ?? props.routeBase ?? env.GSV_ROUTE_BASE ?? STATIC_META.routeBase,
    }, props);
    this.__gsvCtx = ctx;
    this.__gsvApp = app;
    this.__gsvSetupReady = null;
  }

  async __invoke(method, args) {
    if (!this.__gsvSetupReady) {
      this.__gsvSetupReady = ensureSetup(this.__gsvCtx);
    }
    await this.__gsvSetupReady;
    const handler = getAppRpcHandler(this.__gsvApp, method);
    if (!handler) {
      throw new Error(\`Unknown app RPC method: \${method}\`);
    }
    return handler(args, this.__gsvCtx);
  }

${appRpcMethods}}

export class GsvAppRpcEntrypoint extends WorkerEntrypoint {
  async getBackend() {
    const app = getAppDefinition();
    if (!app || !app.rpc || typeof app.rpc !== "object") {
      throw new Error("package app has no rpc handlers");
    }
    return new GsvPackageAppBackend(this.env, this.ctx.props ?? {});
  }
}
`;
}

function workerModulesToAssets(
  prefix: string,
  mainModule: string,
  modules: Record<string, WorkerLoaderModuleLike>,
): { mainAssetPath: string; assets: PublicAsset[] } {
  const assets: PublicAsset[] = [];
  let mainAssetPath = `${prefix}/${normalizePath(mainModule)}`;

  for (const [path, module] of Object.entries(modules)) {
    const assetPath = `${prefix}/${normalizePath(path)}`;
    const converted = workerModuleToAsset(assetPath, module);
    assets.push(converted);
    if (normalizePath(path) === normalizePath(mainModule)) {
      mainAssetPath = assetPath;
    }
  }

  if (!assets.some((asset) => asset.path === mainAssetPath)) {
    const convertedMain = workerModuleToAsset(mainAssetPath, modules[mainModule] ?? "");
    assets.push(convertedMain);
  }

  return {
    mainAssetPath,
    assets,
  };
}

function workerModuleToAsset(path: string, module: WorkerLoaderModuleLike): PublicAsset {
  if (typeof module === "string") {
    return {
      path,
      content: module,
      contentType: contentTypeForPath(path),
    };
  }
  if (typeof module.js === "string") {
    return {
      path,
      content: module.js,
      contentType: "text/javascript; charset=utf-8",
    };
  }
  if (typeof module.cjs === "string") {
    return {
      path,
      content: module.cjs,
      contentType: "text/javascript; charset=utf-8",
    };
  }
  if (typeof module.text === "string") {
    return {
      path,
      content: module.text,
      contentType: contentTypeForPath(path),
    };
  }
  if ("json" in module) {
    return {
      path,
      content: JSON.stringify(module.json),
      contentType: "application/json; charset=utf-8",
    };
  }
  return {
    path,
    content: encodeDataModule(module.data),
    contentType: "text/plain; charset=utf-8",
  };
}

async function toArtifact(
  mainModule: string,
  modules: Record<string, WorkerLoaderModuleLike>,
  passthroughModules: PackageAssemblyArtifactModule[],
): Promise<PackageAssemblyArtifact> {
  const artifactModules = new Map<string, PackageAssemblyArtifactModule>();
  for (const [path, module] of Object.entries(modules)) {
    const converted = convertModule(path, module);
    artifactModules.set(converted.path, converted);
  }
  for (const module of passthroughModules) {
    if (!artifactModules.has(module.path)) {
      artifactModules.set(module.path, module);
    }
  }
  const sortedModules = Array.from(artifactModules.values()).sort((left, right) => left.path.localeCompare(right.path));
  const hashInput = JSON.stringify({
    mainModule,
    modules: sortedModules,
    compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
  const hash = Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");

  return {
    main_module: mainModule,
    modules: sortedModules,
    hash: `sha256:${hash}`,
  };
}

function collectPassthroughArtifactModules(
  analysis: PackageAssemblyAnalysis,
  files: Record<string, string>,
): PackageAssemblyArtifactModule[] {
  const packageRoot = normalizePath(analysis.source.subdir);
  const rootPrefix = packageRoot ? `${packageRoot}/` : "";
  const modules: PackageAssemblyArtifactModule[] = [];

  for (const [path, content] of Object.entries(files)) {
    if (!isPathWithinRoot(path, packageRoot)) {
      continue;
    }

    const relPath = rootPrefix ? path.slice(rootPrefix.length) : path;
    if (!relPath || relPath.startsWith("node_modules/")) {
      continue;
    }

    const kind = inferArtifactModuleKind(path);
    if (kind === "source-module" || kind === "commonjs") {
      continue;
    }

    modules.push({
      path: relPath,
      kind,
      content,
    });
  }

  return modules;
}

function convertModule(path: string, module: WorkerLoaderModuleLike): PackageAssemblyArtifactModule {
  if (typeof module === "string") {
    return {
      path,
      kind: "source-module",
      content: module,
    };
  }
  if (typeof module.js === "string") {
    return {
      path,
      kind: "source-module",
      content: module.js,
    };
  }
  if (typeof module.cjs === "string") {
    return {
      path,
      kind: "commonjs",
      content: module.cjs,
    };
  }
  if (typeof module.text === "string") {
    return {
      path,
      kind: "text",
      content: module.text,
    };
  }
  if ("json" in module) {
    return {
      path,
      kind: "json",
      content: JSON.stringify(module.json),
    };
  }
  return {
    path,
    kind: "data",
    content: encodeDataModule(module.data),
  };
}

function inferArtifactModuleKind(path: string): PackageAssemblyArtifactModule["kind"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (
    lower.endsWith(".ts")
    || lower.endsWith(".tsx")
    || lower.endsWith(".js")
    || lower.endsWith(".jsx")
    || lower.endsWith(".mts")
    || lower.endsWith(".mjs")
  ) {
    return "source-module";
  }
  if (lower.endsWith(".cts") || lower.endsWith(".cjs")) {
    return "commonjs";
  }
  return "text";
}

function encodeDataModule(data: ArrayBuffer | ArrayBufferView | undefined): string {
  if (!data) {
    return "";
  }
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function dedupeAssets(assets: PublicAsset[]): PublicAsset[] {
  const deduped = new Map<string, PublicAsset>();
  for (const asset of assets) {
    deduped.set(asset.path, asset);
  }
  return Array.from(deduped.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function makeWarning(code: string, message: string, path: string): PackageAssemblyDiagnostic {
  return {
    severity: "warning",
    code,
    message,
    path,
    line: 1,
    column: 1,
  };
}

function makeError(code: string, error: unknown, path: string): PackageAssemblyDiagnostic {
  return {
    severity: "error",
    code,
    message: error instanceof Error ? error.message : String(error),
    path,
    line: 1,
    column: 1,
  };
}

function extractHtmlModuleScriptSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const scriptTagPattern = /<script\b([^>]*)>/gi;
  for (const match of source.matchAll(scriptTagPattern)) {
    const attributes = parseHtmlAttributes(match[1] ?? "");
    if (attributes.type?.toLowerCase() !== "module") {
      continue;
    }
    const specifier = attributes.src?.trim() ?? "";
    if (!specifier) {
      continue;
    }
    specifiers.push(specifier);
  }
  return specifiers;
}

function parseHtmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes[name] = value;
  }
  return attributes;
}

function resolveAssetSpecifier(importerPath: string, specifier: string): string {
  const importerDir = dirname(importerPath);
  return normalizePath(joinPosix(importerDir, specifier));
}

function isPathWithinRoot(path: string, root: string): boolean {
  if (!root) {
    return true;
  }
  return path === root || path.startsWith(`${root}/`);
}

function relativeAssetSpecifier(fromPath: string, toPath: string): string {
  const fromParts = splitSegments(dirname(fromPath));
  const toParts = splitSegments(toPath);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }

  const parts: string[] = [];
  for (let index = common; index < fromParts.length; index += 1) {
    parts.push("..");
  }
  for (let index = common; index < toParts.length; index += 1) {
    parts.push(toParts[index]);
  }

  if (parts.length === 0) {
    return "./";
  }
  const joined = parts.join("/");
  return joined.startsWith("../") ? joined : `./${joined}`;
}

function splitSegments(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  segments.pop();
  return segments.join("/");
}

function joinPosix(left: string, right: string): string {
  return normalizePath(`${left.replace(/\/+$/g, "")}/${right.replace(/^\/+/g, "")}`);
}

function normalizePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .reduce<string[]>((segments, segment) => {
      if (segment === "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
      return segments;
    }, [])
    .join("/");
}

function extensionForAssetPath(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? `.${match[1].toLowerCase()}` : ".txt";
}

function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (lower.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}
