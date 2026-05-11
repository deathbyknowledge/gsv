import { WorkerEntrypoint } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { isWebSocketRequest } from "./shared//utils";
import type {
  GatewayAdapterInterface,
} from "./adapter-interface";
import type { Frame } from "./protocol/frames";
import { getAgentByName } from "agents";
import type { AppFrameContext } from "./protocol/app-frame";
import { buildAppRunnerName } from "./protocol/app-session";
import { deserializeAppHttpResponse, serializeAppHttpRequest } from "./app-runner";
import type { PackageArtifactMetadata } from "./kernel/packages";
import {
  buildCliInstallPowerShell,
  buildCliInstallScript,
  cliAssetKey,
  cliChecksumKey,
  isSupportedCliChannel,
  loadDefaultCliChannel,
} from "./downloads/cli";
import { buildOAuthClientMetadata } from "./oauth-http";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";
export { KernelBinding } from "./kernel/packages";
export { AppRunner, GsvApiBinding } from "./app-runner";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/runtime/theme.css") {
      return new Response(RUNTIME_THEME_CSS, {
        headers: {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/.well-known/oauth-client/gsv.json" && request.method === "GET") {
      return Response.json(buildOAuthClientMetadata(url.origin), {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      return kernel.fetch(request);
    }

    const cliDownload = matchCliDownloadPath(url.pathname);
    if (cliDownload) {
      return handleCliDownloadRequest(request, env, url, cliDownload);
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      return kernel.fetch(request);
    }

    if (url.pathname === "/public/packages" && request.method === "GET") {
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      const payload = await kernel.listPublicPackages();
      return Response.json(payload, {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    const gitMatch = matchGitPath(url);
    if (gitMatch) {
      const basicAuth = getBasicAuth(request);
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      const authorized = await kernel.authorizeGitHttp({
        owner: gitMatch.owner,
        repo: gitMatch.repo,
        write: gitMatch.write,
        username: basicAuth?.username,
        credential: basicAuth?.credential,
      });
      if (!authorized.ok) {
        return authorized.status === 401
          ? basicAuthChallenge(authorized.message)
          : new Response(authorized.message, { status: authorized.status });
      }

      return env.RIPGIT.fetch(
        await buildGitProxyRequest(
          request,
          gitMatch,
          authorized.username,
        ),
      );
    }

    const appMatch = matchPackageAppPath(url.pathname);
    if (appMatch) {
      const session = getPackageAppSession(request);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }

      const kernel = await getAgentByName(env.KERNEL, "singleton");
      const resolved = await kernel.resolvePackageHttpRoute({
        packageName: appMatch.packageName,
        username: session.username,
        token: session.token,
        clientId: url.searchParams.get("windowId")?.trim() || undefined,
      });

      if (!resolved.ok) {
        return new Response(resolved.message, { status: resolved.status });
      }

      const runner = ctx.exports.AppRunner.getByName(buildAppRunnerName(resolved.auth.uid, resolved.packageId));
      await runner.ensureRuntime({
        packageId: resolved.packageId,
        packageName: resolved.packageName,
        routeBase: resolved.routeBase,
        entrypointName: resolved.appFrame.entrypointName,
        artifact: resolved.artifact,
        appFrame: resolved.appFrame,
      });

      const response = deserializeAppHttpResponse(
        await runner.gsvFetch(await serializeAppHttpRequest(buildPackageWorkerRequest(request, resolved))),
      );
      return await withPackageAppClientSession(response, resolved);
    }

    const appRpcMatch = matchPackageAppRpcPath(url.pathname);
    if (appRpcMatch) {
      const response = await newWorkersRpcResponse(
        request,
        new PackageAppSessionRpcTarget(env, ctx, appRpcMatch.packageName, appRpcMatch.sessionId),
      );
      response.headers.set("cache-control", "no-store");
      return response;
    }

    const appSessionRefreshMatch = matchPackageAppSessionRefreshPath(url.pathname);
    if (appSessionRefreshMatch) {
      return handlePackageAppSessionRefreshRequest(request, env, appSessionRefreshMatch);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const RUNTIME_THEME_CSS = [
  ":root {",
  "  color-scheme: dark;",
  "  --bg: #07131a;",
  "  --panel: rgba(14, 30, 38, 0.82);",
  "  --edge: rgba(125, 211, 252, 0.24);",
  "  --text: #e6f4f9;",
  "  --muted: #92a8b3;",
  "  --accent: #8ae0ff;",
  "}",
  "html, body { min-height: 100%; }",
  "body {",
  "  margin: 0;",
  "  font-family: \"Avenir Next\", \"Trebuchet MS\", sans-serif;",
  "  background: radial-gradient(circle at top, #123040 0%, #07131a 58%, #03070a 100%);",
  "  color: var(--text);",
  "}",
  "* { box-sizing: border-box; }",
  "a { color: var(--accent); }",
].join("\n");

const PACKAGE_APP_VIEWPORT_META = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">`;

const PACKAGE_APP_RUNTIME_STYLE = [
  "<style data-gsv-package-runtime>",
  "html[data-gsv-runtime-state] body::before,",
  "html[data-gsv-runtime-state] body::after {",
  "  position: fixed;",
  "  left: 50%;",
  "  z-index: 2147483646;",
  "  pointer-events: auto;",
  "  opacity: 1;",
  "  transition: opacity 160ms ease;",
  "}",
  "html[data-gsv-runtime-state] body::before {",
  "  content: \"\";",
  "  inset: 0;",
  "  left: 0;",
  "  background: linear-gradient(180deg, rgba(247, 249, 252, 0.98), rgba(231, 238, 246, 0.96));",
  "}",
  "html[data-gsv-runtime-state] body::after {",
  "  content: attr(data-gsv-runtime-message);",
  "  top: 50%;",
  "  max-width: min(320px, calc(100vw - 48px));",
  "  min-height: 44px;",
  "  padding: 13px 16px;",
  "  border: 1px solid rgba(42, 50, 56, 0.12);",
  "  border-radius: 8px;",
  "  background: rgba(255, 255, 255, 0.92);",
  "  box-shadow: 0 18px 54px rgba(25, 34, 44, 0.14);",
  "  color: #1f2d33;",
  "  font: 600 14px/1.35 system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;",
  "  text-align: center;",
  "  transform: translate(-50%, -50%);",
  "}",
  "html[data-gsv-app-ready=\"true\"] body::before,",
  "html[data-gsv-app-ready=\"true\"] body::after {",
  "  opacity: 0;",
  "  pointer-events: none;",
  "}",
  "html[data-gsv-runtime-state=\"error\"] body::after {",
  "  border-color: rgba(155, 65, 55, 0.24);",
  "  color: #8a3b3b;",
  "}",
  "@media (max-width: 720px) {",
  "  html, body { overscroll-behavior: none; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }",
  "  input, select, textarea { font-size: 16px !important; }",
  "}",
  "</style>",
].join("");

const PACKAGE_APP_RUNTIME_SCRIPT = [
  "(function(){",
  "var root=document.documentElement;",
  "var ready=false;",
  "var fallback=null;",
  "function body(){return document.body;}",
  "function syncMessage(message){root.dataset.gsvRuntimeMessage=message;var b=body();if(b)b.dataset.gsvRuntimeMessage=message;}",
  "function setStatus(state,message){root.dataset.gsvRuntimeState=state;syncMessage(message||defaultMessage(state));}",
  "function clearFallback(){if(fallback!==null){clearTimeout(fallback);fallback=null;}}",
  "function defaultMessage(state){",
  "if(state==='connecting')return 'Connecting app...';",
  "if(state==='connected')return 'Opening app...';",
  "if(state==='loading')return 'Loading app...';",
  "if(state==='reconnecting')return 'Reconnecting app...';",
  "if(state==='error')return 'App unavailable';",
  "return 'Booting app...';",
  "}",
  "function markReady(){ready=true;clearFallback();root.dataset.gsvAppReady='true';setStatus('ready','Ready');}",
  "function showLoading(message){ready=false;clearFallback();delete root.dataset.gsvAppReady;setStatus('loading',message||defaultMessage('loading'));}",
  "function showError(message){ready=false;clearFallback();delete root.dataset.gsvAppReady;setStatus('error',message||defaultMessage('error'));}",
  "function scheduleBootFallback(){clearFallback();fallback=setTimeout(function(){if(!ready&&root.dataset.gsvRuntimeState==='booting')markReady();},800);}",
  "window.__GSV_APP_RUNTIME__={setStatus:setStatus,setLoading:showLoading,setReady:markReady,setError:showError};",
  "setStatus('booting',defaultMessage('booting'));",
  "document.addEventListener('DOMContentLoaded',function(){syncMessage(root.dataset.gsvRuntimeMessage||defaultMessage(root.dataset.gsvRuntimeState));},{once:true});",
  "window.addEventListener('load',scheduleBootFallback,{once:true});",
  "})();",
].join("");

type PackageAppSession = {
  username: string;
  token: string;
};

type BasicAuth = {
  username: string;
  credential: string;
};

type GitPathMatch = {
  owner: string;
  repo: string;
  suffix: string;
  write: boolean;
};

type CliDownloadMatch =
  | { kind: "install-sh" }
  | { kind: "install-ps1" }
  | { kind: "asset"; channel: "latest" | "stable" | "dev"; asset: string; checksum: boolean };

type PackageAppSessionRefreshMatch = {
  packageName: string;
  sessionId: string;
};

type ResolvedPackageRoute = {
  ok: true;
  packageId: string;
  packageName: string;
  routeBase: string;
  artifact: PackageArtifactMetadata;
  appFrame: AppFrameContext;
  clientSession: {
    sessionId: string;
    secret: string;
    clientId: string;
    packageId: string;
    packageName: string;
    routeBase: string;
    rpcBase: string;
    createdAt: number;
    expiresAt: number;
  };
  hasRpc: boolean;
  auth: {
    uid: number;
    username: string;
    capabilities: string[];
  };
};

type ResolvedPackageAppRpcSession =
  | {
      ok: true;
      packageId: string;
      packageName: string;
      routeBase: string;
      artifact: PackageArtifactMetadata;
      appFrame: AppFrameContext;
      clientSession: {
        sessionId: string;
      clientId: string;
      packageId: string;
      packageName: string;
        routeBase: string;
        rpcBase: string;
        createdAt: number;
        expiresAt: number;
      };
      hasRpc: boolean;
      auth: {
        uid: number;
        username: string;
        capabilities: string[];
      };
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

function matchPackageAppPath(pathname: string): { packageName: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "apps") {
    return null;
  }

  const rawName = parts[1]?.trim();
  if (!rawName || !/^[a-z0-9][a-z0-9-]*$/.test(rawName)) {
    return null;
  }

  return { packageName: rawName };
}

function matchPackageAppRpcPath(
  pathname: string,
): { packageName: string; sessionId: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "app-rpc" || parts[2] !== "sessions") {
    return null;
  }

  const packageName = parts[1]?.trim();
  const sessionId = parts[3]?.trim();
  if (!packageName || !sessionId) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageName)) {
    return null;
  }
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    return null;
  }

  return { packageName, sessionId };
}

function matchPackageAppSessionRefreshPath(pathname: string): PackageAppSessionRefreshMatch | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "app-rpc" || parts[2] !== "sessions" || parts[4] !== "refresh") {
    return null;
  }

  const packageName = parts[1]?.trim();
  const sessionId = parts[3]?.trim();
  if (!packageName || !sessionId) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageName)) {
    return null;
  }
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    return null;
  }

  return { packageName, sessionId };
}

function matchCliDownloadPath(pathname: string): CliDownloadMatch | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "downloads" || parts[1] !== "cli") {
    return null;
  }
  if (parts.length === 3 && parts[2] === "install.sh") {
    return { kind: "install-sh" };
  }
  if (parts.length === 3 && parts[2] === "install.ps1") {
    return { kind: "install-ps1" };
  }
  if (parts.length !== 4) {
    return null;
  }
  const channel = parts[2];
  if (channel !== "latest" && !isSupportedCliChannel(channel)) {
    return null;
  }
  const rawAsset = parts[3]?.trim() ?? "";
  if (!/^[A-Za-z0-9._-]+(?:\.exe)?(?:\.sha256)?$/.test(rawAsset)) {
    return null;
  }
  const checksum = rawAsset.endsWith(".sha256");
  const asset = checksum ? rawAsset.slice(0, -".sha256".length) : rawAsset;
  return { kind: "asset", channel, asset, checksum };
}

function matchGitPath(url: URL): GitPathMatch | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "git") {
    return null;
  }

  const owner = parts[1]?.trim();
  const repoPart = parts[2]?.trim();
  if (!owner || !repoPart) {
    return null;
  }

  const repo = repoPart.endsWith(".git") ? repoPart.slice(0, -4) : repoPart;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return null;
  }

  const suffix = parts.slice(3).join("/");
  const service = url.searchParams.get("service");
  return {
    owner,
    repo,
    suffix,
    write: suffix === "git-receive-pack" || (suffix === "info/refs" && service === "git-receive-pack"),
  };
}

async function handleCliDownloadRequest(
  request: Request,
  env: Env,
  url: URL,
  match: CliDownloadMatch,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (match.kind === "install-sh") {
    return new Response(buildCliInstallScript(url.origin), {
      headers: {
        "content-type": "application/x-sh; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (match.kind === "install-ps1") {
    return new Response(buildCliInstallPowerShell(url.origin), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const channel = match.channel === "latest"
    ? await loadDefaultCliChannel(env.STORAGE)
    : match.channel;
  const key = match.checksum ? cliChecksumKey(channel, match.asset) : cliAssetKey(channel, match.asset);
  const object = await env.STORAGE.get(key);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "content-type": match.checksum ? "text/plain; charset=utf-8" : "application/octet-stream",
      "cache-control": match.channel === "latest" ? "no-store" : "public, max-age=300",
      "content-disposition": match.checksum
        ? `inline; filename="${match.asset}.sha256"`
        : `attachment; filename="${match.asset}"`,
    },
  });
}

function getBasicAuth(request: Request): BasicAuth | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(header.slice("Basic ".length).trim());
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const username = decoded.slice(0, separator).trim();
    const credential = decoded.slice(separator + 1);
    if (!username || !credential) {
      return null;
    }
    return { username, credential };
  } catch {
    return null;
  }
}

function basicAuthChallenge(message: string): Response {
  return new Response(message, {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="gsv"',
    },
  });
}

function getPackageAppSession(request: Request): PackageAppSession | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    const username = request.headers.get("x-gsv-username")?.trim() ?? "";
    if (username && token) {
      return { username, token };
    }
  }

  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const username = cookies.get("gsv_app_user") ?? "";
  const token = cookies.get("gsv_app_token") ?? "";
  if (!username || !token) {
    return null;
  }

  return { username, token };
}

function parseCookieHeader(raw: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) {
    return map;
  }

  for (const chunk of raw.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    try {
      map.set(key, decodeURIComponent(value));
    } catch {
      map.set(key, value);
    }
  }

  return map;
}

function buildPackageWorkerRequest(request: Request, resolved: ResolvedPackageRoute): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-gsv-username");
  headers.set("x-gsv-auth-uid", String(resolved.auth.uid));
  headers.set("x-gsv-auth-username", resolved.auth.username);
  headers.set("x-gsv-auth-capabilities", resolved.auth.capabilities.join(","));
  headers.set("x-gsv-package-id", resolved.packageId);
  headers.set("x-gsv-package-name", resolved.packageName);

  return new Request(request, { headers });
}

async function handlePackageAppSessionRefreshRequest(
  request: Request,
  env: Env,
  match: PackageAppSessionRefreshMatch,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const session = getPackageAppSession(request);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  let clientId: string | undefined;
  try {
    clientId = await readRefreshClientId(request);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const kernel = await getAgentByName(env.KERNEL, "singleton");
  const resolved = await kernel.resolvePackageHttpRoute({
    packageName: match.packageName,
    username: session.username,
    token: session.token,
    clientId,
  });

  if (!resolved.ok) {
    return new Response(resolved.message, { status: resolved.status });
  }

  return Response.json(buildPackageAppBoot(resolved), {
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function readRefreshClientId(request: Request): Promise<string | undefined> {
  const text = await request.text();
  if (!text.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const clientId = (parsed as { clientId?: unknown }).clientId;
  return typeof clientId === "string" && clientId.trim().length > 0
    ? clientId.trim()
    : undefined;
}

async function withPackageAppClientSession(
  response: Response,
  resolved: ResolvedPackageRoute,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  if (isHtmlResponse(response)) {
    const html = await response.text();
    return new Response(injectAppBootstrapHtml(html, resolved), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.startsWith("text/html");
}

function injectAppBootstrapHtml(html: string, resolved: ResolvedPackageRoute): string {
  const boot = JSON.stringify(buildPackageAppBoot(resolved))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const scriptLines = [
    `<script>window.__GSV_APP_BOOT__=${boot};${PACKAGE_APP_RUNTIME_SCRIPT}</script>`,
  ];
  if (resolved.hasRpc) {
    scriptLines.push(
      `<script type="module">`,
      `import { RpcTarget, newWebSocketRpcSession } from "https://cdn.jsdelivr.net/npm/capnweb@0.6.1/+esm";`,
      `window.capnweb={ RpcTarget, newWebSocketRpcSession };`,
      "</script>",
    );
  }
  const headExtras = [
    htmlHasViewportMeta(html) ? "" : PACKAGE_APP_VIEWPORT_META,
    PACKAGE_APP_RUNTIME_STYLE,
    scriptLines.join(""),
  ].join("");

  const headInjected = injectBeforeClosingTag(html, "head", headExtras);
  if (headInjected !== html) {
    return headInjected;
  }
  const bodyInjected = injectBeforeClosingTag(html, "body", headExtras);
  if (bodyInjected !== html) {
    return bodyInjected;
  }
  return `${headExtras}${html}`;
}

function htmlHasViewportMeta(html: string): boolean {
  return /<meta\b[^>]*\bname\s*=\s*["']?viewport["']?/i.test(html);
}

function injectBeforeClosingTag(html: string, tagName: string, content: string): string {
  const pattern = new RegExp(`</${tagName}>`, "i");
  return html.replace(pattern, `${content}$&`);
}

function buildPackageAppBoot(resolved: ResolvedPackageRoute) {
  return {
    packageId: resolved.packageId,
    packageName: resolved.packageName,
    routeBase: resolved.routeBase,
    rpcBase: resolved.clientSession.rpcBase,
    sessionId: resolved.clientSession.sessionId,
    sessionSecret: resolved.clientSession.secret,
    clientId: resolved.clientSession.clientId,
    expiresAt: resolved.clientSession.expiresAt,
    hasBackend: resolved.hasRpc,
  };
}

class PackageAppSessionRpcTarget extends RpcTarget {
  constructor(
    private readonly env: Env,
    private readonly ctx: ExecutionContext,
    private readonly packageName: string,
    private readonly sessionId: string,
  ) {
    super();
  }

  async authenticate(secret: string, clientTarget?: unknown): Promise<unknown> {
    const kernel = await getAgentByName(this.env.KERNEL, "singleton");
    const resolved = await kernel.resolvePackageAppRpcSession({
      packageName: this.packageName,
      sessionId: this.sessionId,
      secret,
    }) as ResolvedPackageAppRpcSession;

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const runner = this.ctx.exports.AppRunner.getByName(buildAppRunnerName(resolved.auth.uid, resolved.packageId));
    await runner.ensureRuntime({
      packageId: resolved.packageId,
      packageName: resolved.packageName,
      routeBase: resolved.routeBase,
      entrypointName: resolved.appFrame.entrypointName,
      artifact: resolved.artifact,
      appFrame: resolved.appFrame,
    });

    return runner.getBackend(
      {
        sessionId: resolved.clientSession.sessionId,
        clientId: resolved.clientSession.clientId,
        rpcBase: resolved.clientSession.rpcBase,
        expiresAt: resolved.clientSession.expiresAt,
      },
      clientTarget && (typeof clientTarget === "object" || typeof clientTarget === "function")
        ? clientTarget as never
        : null,
    );
  }
}

async function buildGitProxyRequest(
  request: Request,
  gitMatch: GitPathMatch,
  username: string | null,
): Promise<Request> {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`https://ripgit/${encodeURIComponent(gitMatch.owner)}/${encodeURIComponent(gitMatch.repo)}/${gitMatch.suffix}`);
  targetUrl.search = sourceUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  if (username) {
    headers.set("x-ripgit-actor-name", username);
  } else {
    headers.delete("x-ripgit-actor-name");
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return new Request(targetUrl.toString(), init);
}

/**
 * Gateway Entrypoint for Service Binding RPC
 *
 * Adapter workers call these methods via Service Bindings.
 * This provides a secure, type-safe interface for adapters to deliver
 * inbound messages to the Gateway.
 */
export class GatewayEntrypoint
  extends WorkerEntrypoint<Env>
  implements GatewayAdapterInterface
{
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    try {
      const kernel = await getAgentByName(this.env.KERNEL, "singleton");
      return await kernel.serviceFrame(frame);
    } catch (e) {
      console.error("[GatewayEntrypoint] serviceFrame failed:", e);
      return null;
    }
  }
}
