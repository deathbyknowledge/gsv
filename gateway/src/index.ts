import { WorkerEntrypoint } from "cloudflare:workers";
import { isWebSocketRequest } from "./shared/utils";
import type {
  GatewayAdapterInterface,
} from "./adapter-interface";
import type { Frame, RequestFrame, ResponseFrame } from "./protocol/frames";
import { getAgentByName } from "agents";
import type { AppFrameContext } from "./protocol/app-frame";
import {
  buildAppClientRouteBase,
  buildAppRunnerName,
  isLegacyAppSessionId,
  MAX_APP_SESSION_ID_LENGTH,
  parseRoutedAppSessionId,
} from "./protocol/app-session";
import type { PackageArtifactMetadata } from "./kernel/packages";
import { captureAppRunnerRuntime } from "./app-runner";
import { buildOAuthClientMetadata } from "./oauth-http";
import {
  createPublicAssetFileSystem,
  matchPublicAssetPath,
  servePublicAssetRequest,
} from "./public-assets";
import {
  ACCOUNT_USERNAME_MAX_CHARACTERS,
  LOGIN_CREDENTIAL_MAX_BYTES,
} from "./auth/login";
import {
  matchUserKernelWebSocketPath,
  SHIP_KERNEL_NAME,
  USER_KERNEL_GENERATION_HEADER,
  USER_KERNEL_LOGIN_SOURCE_HEADER,
  userKernelName,
} from "./shared/kernel-names";
import type { LoginSourceScope } from "./kernel/login-source";
import {
  buildUserMcpOAuthCallbackPath,
  matchUserMcpOAuthCallbackPath,
  parseRoutedOAuthState,
} from "./shared/callback-routes";
import {
  ADAPTER_INBOUND_GATEWAY_SOURCE,
  adapterInboundRouteMetadata,
  type AdapterInboundRouteMetadata,
  type AdapterInboundRouteResult,
} from "./shared/adapter-inbound-route";
import {
  cancelAppLaunchRequestBody,
  readAppLaunchToken,
} from "./shared/app-launch-token";
import { verifyAppPlacementAtEdge } from "./shared/app-placement-verifier";

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
      const rawUsername = url.searchParams.get("username");
      const rawGeneration = url.searchParams.get("generation");
      let metadataOptions: { clientId?: string; redirectUri?: string } = {};
      if (rawUsername !== null || rawGeneration !== null) {
        const generation = Number(rawGeneration);
        const master = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
        const route = await master.resolveUserKernelCallbackRoute(
          rawUsername ?? "",
          generation,
        );
        if (!route.ok) {
          return new Response("Not Found", { status: 404 });
        }
        metadataOptions = {
          clientId: url.toString(),
          redirectUri: `${url.origin}${buildUserMcpOAuthCallbackPath(
            rawUsername!,
            generation,
          )}`,
        };
      }
      return Response.json(buildOAuthClientMetadata(url.origin, metadataOptions), {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const routed = parseRoutedOAuthState(url.searchParams.get("state"));
      if (routed) {
        const kernel = await resolveActiveUserCallbackKernel(
          env,
          routed.username,
          routed.generation,
        );
        return kernel
          ? kernel.fetch(request)
          : new Response("Not Found", { status: 404 });
      }
      const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
      return kernel.fetch(request);
    }

    const mcpOAuthRoute = matchUserMcpOAuthCallbackPath(url.pathname);
    if (mcpOAuthRoute && request.method === "GET") {
      const kernel = await resolveActiveUserCallbackKernel(
        env,
        mcpOAuthRoute.username,
        mcpOAuthRoute.generation,
      );
      return kernel
        ? kernel.fetch(request)
        : new Response("Not Found", { status: 404 });
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
      return kernel.fetch(request);
    }

    if (url.pathname.startsWith("/ws/") && isWebSocketRequest(request)) {
      const username = matchUserKernelWebSocketPath(url.pathname);
      if (!username) {
        return new Response("Not Found", { status: 404 });
      }
      const master = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
      const route = await master.resolveUserKernelRoute(
        username,
        trustedLoginSourceAddress(request),
      );
      if (!route.ok) {
        return new Response("Not Found", {
          status: 404,
          headers: { "cache-control": "no-store" },
        });
      }
      const kernel = await getAgentByName(env.KERNEL, route.kernelName);
      if (route.lifecycle === "legacy") {
        return kernel.fetch(request);
      }
      return kernel.fetch(buildUserKernelWebSocketRequest(
        request,
        route.loginSourceScope,
        route.generation,
      ));
    }

    if (url.pathname === "/public/packages" && request.method === "GET") {
      const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
      const payload = await kernel.listPublicPackages();
      return Response.json(payload, {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (isRetiredCliDownloadPath(url.pathname)) {
      return new Response("CLI downloads moved to https://install.gsv.space", {
        status: 410,
        headers: { "cache-control": "no-store" },
      });
    }

    const publicAssetMatch = matchPublicAssetPath(url.pathname);
    if (publicAssetMatch) {
      return servePublicAssetRequest(request, createPublicAssetFileSystem(env), publicAssetMatch);
    }

    const gitMatch = matchGitPath(url);
    if (gitMatch) {
      const basicAuth = getBasicAuth(request);
      const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
      const authorized = await kernel.authorizeGitHttp({
        owner: gitMatch.owner,
        repo: gitMatch.repo,
        write: gitMatch.write,
        trustedSourceAddress: trustedLoginSourceAddress(request),
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

    const appSessionMatch = matchPackageAppSessionPath(url.pathname);
    if (appSessionMatch) {
      return handlePackageAppSessionRequest(request, env, ctx, appSessionMatch);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const RETIRED_CLI_DOWNLOAD_PATH = "/public/gsv/downloads/cli";

export function isRetiredCliDownloadPath(pathname: string): boolean {
  return pathname === RETIRED_CLI_DOWNLOAD_PATH
    || pathname.startsWith(`${RETIRED_CLI_DOWNLOAD_PATH}/`);
}

/** Only the public gateway may forward Cloudflare's edge-authored source header. */
export function trustedLoginSourceAddress(request: Request): string | undefined {
  return request.headers.get("CF-Connecting-IP") ?? undefined;
}

/** Replace edge-only source metadata before a request enters a user Kernel. */
export function buildUserKernelWebSocketRequest(
  request: Request,
  loginSourceScope: LoginSourceScope,
  generation: number,
): Request {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Invalid user Kernel generation");
  }
  const headers = new Headers(request.headers);
  headers.delete("CF-Connecting-IP");
  headers.set(USER_KERNEL_LOGIN_SOURCE_HEADER, loginSourceScope);
  headers.set(USER_KERNEL_GENERATION_HEADER, String(generation));
  return new Request(request, { headers });
}

async function resolveActiveUserCallbackKernel(
  env: Env,
  username: string,
  generation: number,
) {
  const master = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
  const route = await master.resolveUserKernelCallbackRoute(username, generation);
  return route.ok ? getAgentByName(env.KERNEL, route.kernelName) : null;
}

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
  "function defaultMessage(state){",
  "if(state==='connecting')return 'Connecting app...';",
  "if(state==='connected')return 'Opening app...';",
  "if(state==='loading')return 'Loading app...';",
  "if(state==='reconnecting')return 'Reconnecting app...';",
  "if(state==='error')return 'App unavailable';",
  "if(state==='ready')return 'Ready';",
  "return 'Booting app...';",
  "}",
  "function postStatus(state,message){try{if(window.parent&&window.parent!==window)window.parent.postMessage({type:'gsv-app-runtime-status',state:state,message:message||''},window.location.origin);}catch(_){}}",
  "function syncMessage(message){root.dataset.gsvRuntimeMessage=message;var b=body();if(b)b.dataset.gsvRuntimeMessage=message;}",
  "function clearFallback(){if(fallback!==null){clearTimeout(fallback);fallback=null;}}",
  "function clearReady(){ready=false;delete root.dataset.gsvAppReady;}",
  "function setStatus(state,message){if(state==='ready'){markReady();return;}if(state==='loading'||state==='error')clearReady();root.dataset.gsvRuntimeState=state;var resolved=message||defaultMessage(state);syncMessage(resolved);postStatus(state,resolved);}",
  "function markReady(){ready=true;clearFallback();root.dataset.gsvRuntimeState='ready';root.dataset.gsvAppReady='true';syncMessage(defaultMessage('ready'));postStatus('ready',defaultMessage('ready'));}",
  "function showLoading(message){clearFallback();setStatus('loading',message||defaultMessage('loading'));}",
  "function showError(message){clearFallback();setStatus('error',message||defaultMessage('error'));}",
  "function scheduleBootFallback(){clearFallback();fallback=setTimeout(function(){if(!ready&&root.dataset.gsvRuntimeState==='booting')markReady();},800);}",
  "window.__GSV_APP_RUNTIME__={setStatus:setStatus,setLoading:showLoading,setReady:markReady,setError:showError};",
  "setStatus('booting',defaultMessage('booting'));",
  "window.addEventListener('load',scheduleBootFallback,{once:true});",
  "})();",
].join("");

const PACKAGE_APP_SESSION_COOKIE_PREFIX = "gsv_app_session_";
const GIT_REPO_SEGMENT_MAX_CHARACTERS = 128;
const BASIC_AUTH_PREFIX = "Basic ";
const MAX_GIT_BASIC_AUTH_HEADER_LENGTH = BASIC_AUTH_PREFIX.length
  + 4 * Math.ceil(
    (ACCOUNT_USERNAME_MAX_CHARACTERS + 1 + LOGIN_CREDENTIAL_MAX_BYTES) / 3,
  )
  + 8;

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

type PackageAppSessionRefreshMatch = {
  sessionId: string;
  clientId: string;
};

type PackageAppSessionPathMatch = {
  sessionId: string;
  clientId: string | null;
  suffix: string;
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

export function matchPackageAppSessionPath(pathname: string): PackageAppSessionPathMatch | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "apps" || parts[1] !== "sessions") {
    return null;
  }

  const rawSessionId = parts[2];
  if (
    !rawSessionId
    || rawSessionId.length > MAX_APP_SESSION_ID_LENGTH * 3
    || rawSessionId !== rawSessionId.trim()
  ) {
    return null;
  }
  let sessionId = "";
  try {
    sessionId = decodeURIComponent(rawSessionId);
  } catch {
    return null;
  }
  if (
    sessionId !== sessionId.trim()
    || (!isLegacyAppSessionId(sessionId) && !parseRoutedAppSessionId(sessionId))
  ) {
    return null;
  }

  const suffixParts = parts.slice(3);
  if (suffixParts[0] === "clients") {
    const rawClientId = suffixParts[1]?.trim();
    if (!rawClientId) {
      return null;
    }
    let clientId = "";
    try {
      clientId = decodeURIComponent(rawClientId).trim();
    } catch {
      return null;
    }
    if (!clientId) {
      return null;
    }
    const clientSuffixParts = suffixParts.slice(2);
    return {
      sessionId,
      clientId,
      suffix: clientSuffixParts.length > 0 ? `/${clientSuffixParts.join("/")}` : "/",
    };
  }

  return {
    sessionId,
    clientId: null,
    suffix: suffixParts.length > 0 ? `/${suffixParts.join("/")}` : "/",
  };
}

function matchGitPath(url: URL): GitPathMatch | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "git") {
    return null;
  }

  const owner = parts[1] ?? "";
  const repoPart = parts[2] ?? "";
  if (!owner || !repoPart) {
    return null;
  }
  if (
    owner.length > GIT_REPO_SEGMENT_MAX_CHARACTERS
    || repoPart.length > GIT_REPO_SEGMENT_MAX_CHARACTERS + ".git".length
  ) {
    return null;
  }

  const repo = repoPart.endsWith(".git") ? repoPart.slice(0, -4) : repoPart;
  if (repo.length > GIT_REPO_SEGMENT_MAX_CHARACTERS) {
    return null;
  }
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

function getBasicAuth(request: Request): BasicAuth | null {
  const header = request.headers.get("authorization");
  if (
    !header?.startsWith(BASIC_AUTH_PREFIX)
    || header.length > MAX_GIT_BASIC_AUTH_HEADER_LENGTH
  ) {
    return null;
  }

  try {
    const decoded = atob(header.slice(BASIC_AUTH_PREFIX.length).trim());
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const username = decoded.slice(0, separator);
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

function getPackageAppSessionSecret(request: Request, sessionId: string, clientId: string): string {
  return parseCookieHeader(request.headers.get("cookie")).get(packageAppSessionCookieName(sessionId, clientId)) ?? "";
}

function buildPackageAppSessionCookie(
  request: Request,
  sessionId: string,
  clientId: string,
  secret: string,
  expiresAt: number,
): string {
  const url = new URL(request.url);
  const maxAgeSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  const parts = [
    `${packageAppSessionCookieName(sessionId, clientId)}=${encodeURIComponent(secret)}`,
    "HttpOnly",
    "SameSite=Strict",
    `Path=${packageAppSessionCookiePath(sessionId, clientId)}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (url.protocol === "https:") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function packageAppSessionCookieName(sessionId: string, clientId: string): string {
  return `${PACKAGE_APP_SESSION_COOKIE_PREFIX}${cookieNameSegment(sessionId)}_${cookieNameSegment(clientId)}`;
}

function cookieNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "_") || "id";
}

function packageAppSessionCookiePath(sessionId: string, clientId: string): string {
  return buildAppClientRouteBase(sessionId, clientId);
}

export function packageWorkerPath(routeBase: string, suffix: string): string {
  if (!suffix || suffix === "/") {
    return `${routeBase}/`;
  }
  return `${routeBase}${suffix}`;
}

export function packageAppClientResponseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  return headers;
}

function buildPackageWorkerRequest(
  request: Request,
  resolved: ResolvedPackageRoute,
  sessionSuffix = "/",
): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-gsv-username");
  headers.set("x-gsv-auth-uid", String(resolved.auth.uid));
  headers.set("x-gsv-auth-username", resolved.auth.username);
  headers.set("x-gsv-auth-capabilities", resolved.auth.capabilities.join(","));
  headers.set("x-gsv-package-id", resolved.packageId);
  headers.set("x-gsv-package-name", resolved.packageName);

  const url = new URL(request.url);
  url.pathname = packageWorkerPath(resolved.routeBase, sessionSuffix);

  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  return new Request(url.toString(), init);
}

async function handlePackageAppSessionRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  match: PackageAppSessionPathMatch,
): Promise<Response> {
  if (match.suffix === "/launch" && !match.clientId) {
    return handlePackageAppSessionLaunchRequest(request, env, match);
  }

  if (!match.clientId) {
    return new Response("App client route required", { status: 404 });
  }

  if (match.suffix === "/socket") {
    if (!isWebSocketRequest(request)) {
      return new Response("App socket requires WebSocket", {
        status: 426,
        headers: {
          "cache-control": "no-store",
          upgrade: "websocket",
        },
      });
    }
    return handlePackageAppSocketRequest(request, env, ctx, match);
  }

  if (match.suffix === "/refresh") {
    return handlePackageAppSessionRefreshRequest(request, env, {
      sessionId: match.sessionId,
      clientId: match.clientId,
    });
  }

  if (match.suffix === "/launch") {
    return new Response("Not Found", { status: 404 });
  }

  const resolved = await resolvePackageAppSessionFromCookie(request, env, match.sessionId, match.clientId);
  if (!resolved.ok) {
    return new Response(resolved.message, { status: resolved.status });
  }

  const runner = ctx.exports.AppRunner.getByName(buildAppRunnerName(
    resolved.appFrame.kernelOwnerUid,
    resolved.auth.uid,
    resolved.packageId,
  ));
  const runtime = captureAppRunnerRuntime({
    artifact: resolved.artifact,
    appFrame: resolved.appFrame,
  });

  const response = await runner.gsvFetch(
    buildPackageWorkerRequest(request, resolved, match.suffix),
    runtime,
  );
  return await withPackageAppClientSession(response, resolved);
}

async function handlePackageAppSessionLaunchRequest(
  request: Request,
  env: Env,
  match: PackageAppSessionPathMatch,
): Promise<Response> {
  if (request.method !== "POST") {
    await cancelAppLaunchRequestBody(request, "App launch method rejected");
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  let kernel: Awaited<ReturnType<typeof resolvePackageAppSessionKernel>>;
  try {
    // Select the bounded routed locator and verify the target's exact active
    // marker before accepting any caller-controlled body bytes. The full
    // session id and launch secret are authorized together after parsing.
    kernel = await resolvePackageAppSessionKernel(env, match.sessionId);
  } catch (error) {
    await cancelAppLaunchRequestBody(request, "App session route failed");
    throw error;
  }
  if (!kernel) {
    await cancelAppLaunchRequestBody(request, "App session route rejected");
    return new Response("Not Found", { status: 404 });
  }
  const token = await readAppLaunchToken(request);
  if (!token.ok) {
    return new Response(token.tooLarge ? "Payload Too Large" : "Unauthorized", {
      status: token.tooLarge ? 413 : 401,
    });
  }
  const secret = token.token;
  const resolved = await kernel.resolvePackageAppRpcSession({
    sessionId: match.sessionId,
    secret,
  });

  if (!resolved.ok) {
    return new Response(resolved.message, { status: resolved.status });
  }

  return packageAppSessionLaunchResponse(
    request,
    resolved,
    secret,
  );
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

  const secret = getPackageAppSessionSecret(request, match.sessionId, match.clientId);

  const kernel = await resolvePackageAppSessionKernel(env, match.sessionId);
  if (!kernel) {
    return new Response("Not Found", { status: 404 });
  }
  const resolved = await kernel.refreshPackageAppRpcSession({
    sessionId: match.sessionId,
    secret,
  });

  if (!resolved.ok) {
    return new Response(resolved.message, { status: resolved.status });
  }
  if (resolved.clientSession.clientId !== match.clientId) {
    return new Response("Unauthorized", { status: 401 });
  }

  return Response.json(buildPackageAppBoot(resolved), {
    headers: {
      "cache-control": "no-store",
      "set-cookie": buildPackageAppSessionCookie(
        request,
        match.sessionId,
        match.clientId,
        secret,
        resolved.clientSession.expiresAt,
      ),
    },
  });
}

async function handlePackageAppSocketRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  match: PackageAppSessionPathMatch,
): Promise<Response> {
  if (!match.clientId) {
    return new Response("App client route required", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const resolved = await resolvePackageAppSessionFromCookie(request, env, match.sessionId, match.clientId);
  if (!resolved.ok) {
    return new Response(resolved.message, {
      status: resolved.status,
      headers: { "cache-control": "no-store" },
    });
  }
  const runner = ctx.exports.AppRunner.getByName(buildAppRunnerName(
    resolved.appFrame.kernelOwnerUid,
    resolved.auth.uid,
    resolved.packageId,
  ));
  const runtime = captureAppRunnerRuntime({
    artifact: resolved.artifact,
    appFrame: resolved.appFrame,
  });

  const headers = new Headers(request.headers);
  headers.set("x-gsv-app-socket-context", encodeURIComponent(JSON.stringify({
    session: {
      sessionId: resolved.clientSession.sessionId,
      clientId: resolved.clientSession.clientId,
      rpcBase: resolved.clientSession.rpcBase,
      expiresAt: resolved.clientSession.expiresAt,
    },
    runtime,
  })));
  return runner.fetch(new Request(request, { headers }));
}

async function resolvePackageAppSessionFromCookie(
  request: Request,
  env: Env,
  sessionId: string,
  clientId: string,
): Promise<ResolvedPackageRoute | { ok: false; status: number; message: string }> {
  const secret = getPackageAppSessionSecret(request, sessionId, clientId);
  if (!secret) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const kernel = await resolvePackageAppSessionKernel(env, sessionId);
  if (!kernel) {
    return { ok: false, status: 404, message: "Not Found" };
  }
  const resolved = await kernel.resolvePackageAppRpcSession({
    sessionId,
    secret,
  });
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.clientSession.clientId !== clientId) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  return resolved;
}

async function resolvePackageAppSessionKernel(env: Env, sessionId: string) {
  const routed = parseRoutedAppSessionId(sessionId);
  if (routed) {
    if (routed.expiresAt <= Date.now()) {
      return null;
    }
    // Keep public ingress controls and cryptographic placement verification on
    // the edge side of target selection. A forged locator must never create or
    // wake a caller-chosen Durable Object name.
    if (!await verifyAppPlacementAtEdge(
      env.STORAGE,
      {
        username: routed.username,
        uid: routed.uid,
        generation: routed.generation,
      },
      routed.placementCertificate,
    )) {
      return null;
    }
    // The Master certificate is only a placement proof. The selected user
    // Kernel must still match its exact active marker and authorize the local
    // HMAC/session state.
    const kernel = await getAgentByName(
      env.KERNEL,
      userKernelName(routed.username),
    );
    return await kernel.authorizeAppSessionRoute(sessionId) ? kernel : null;
  }

  if (!isLegacyAppSessionId(sessionId)) {
    return null;
  }
  const master = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
  const route = await master.resolveAppSessionKernel(sessionId);
  return route.ok && route.lifecycle === "legacy" && route.kernelName === SHIP_KERNEL_NAME
    ? master
    : null;
}

function packageAppSessionLaunchResponse(
  request: Request,
  resolved: ResolvedPackageRoute,
  secret: string,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "set-cookie": buildPackageAppSessionCookie(
      request,
      resolved.clientSession.sessionId,
      resolved.clientSession.clientId,
      secret,
      resolved.clientSession.expiresAt,
    ),
  });
  return Response.json({ ok: true }, { headers });
}

async function withPackageAppClientSession(
  response: Response,
  resolved: ResolvedPackageRoute,
): Promise<Response> {
  const headers = packageAppClientResponseHeaders(response);

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
    routeBase: packageAppSessionCookiePath(resolved.clientSession.sessionId, resolved.clientSession.clientId),
    rpcBase: resolved.clientSession.rpcBase,
    sessionId: resolved.clientSession.sessionId,
    clientId: resolved.clientSession.clientId,
    expiresAt: resolved.clientSession.expiresAt,
    hasBackend: resolved.hasRpc,
  };
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
    await cancelFrameRequestBody(frame, "Unscoped adapter entrypoint is disabled");
    return frame.type === "req"
      ? {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: 403, message: "Scoped adapter entrypoint required" },
        }
      : null;
  }
}

abstract class ScopedGatewayAdapterEntrypoint
  extends WorkerEntrypoint<Env>
  implements GatewayAdapterInterface
{
  protected abstract readonly adapter: string;

  async serviceFrame(frame: Frame): Promise<Frame | null> {
    if (frame.type !== "req") {
      return null;
    }
    const args = frame.args && typeof frame.args === "object"
      ? frame.args as Record<string, unknown>
      : null;
    const claimedAdapter = typeof args?.adapter === "string"
      ? args.adapter.trim().toLowerCase()
      : "";
    if (
      claimedAdapter !== this.adapter
      || (frame.call !== "adapter.inbound" && frame.call !== "adapter.state.update")
    ) {
      await cancelFrameRequestBody(frame, "Adapter service scope rejected");
      return {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: 403, message: "Permission denied" },
      };
    }
    if (frame.body) {
      await cancelFrameRequestBody(frame, "Adapter request bodies are not supported");
      return {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: 400, message: "Adapter request bodies are not supported" },
      };
    }

    try {
      const master = await getAgentByName(this.env.KERNEL, SHIP_KERNEL_NAME);
      if (frame.call === "adapter.state.update") {
        return await master.serviceFrame(frame);
      }

      const inboundFrame = frame as RequestFrame<"adapter.inbound">;
      const metadata = adapterInboundRouteMetadata(inboundFrame);
      if (!metadata || metadata.adapter !== this.adapter) {
        return {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: 400, message: "Invalid adapter request" },
        };
      }
      const route = await (master as unknown as {
        issueAdapterInboundRoute: (
          input: typeof metadata,
        ) => Promise<AdapterInboundRouteResult>;
      }).issueAdapterInboundRoute(metadata);
      if (route.kind === "response") {
        return { type: "res", id: frame.id, ok: true, data: route.data };
      }
      if (route.kind === "error") {
        return {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: route.code, message: route.message },
        };
      }
      if (route.kind === "legacy") {
        return await master.serviceFrame(frame);
      }
      if (!isActiveAdapterInboundRoute(route)) {
        return {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: 401, message: "Authentication failed" },
        };
      }
      const userKernel = await getAgentByName(
        this.env.KERNEL,
        route.targetKernelName,
      ) as unknown as {
        serviceLinkedAdapterFrame: (input: AdapterInboundRouteMetadata & {
          source: typeof ADAPTER_INBOUND_GATEWAY_SOURCE;
          authorization: string;
          username: string;
          ownerUid: number;
          generation: number;
          linkGeneration: number;
          frame: RequestFrame<"adapter.inbound">;
        }) => Promise<ResponseFrame>;
      };
      return await userKernel.serviceLinkedAdapterFrame({
        source: ADAPTER_INBOUND_GATEWAY_SOURCE,
        authorization: route.authorization,
        username: route.username,
        ownerUid: route.ownerUid,
        generation: route.generation,
        linkGeneration: route.linkGeneration,
        ...metadata,
        frame: inboundFrame,
      });
    } catch (e) {
      await cancelFrameRequestBody(frame, "Gateway service forwarding failed");
      console.error("[GatewayEntrypoint] serviceFrame failed:", e);
      return null;
    }
  }
}

function isActiveAdapterInboundRoute(
  route: Extract<AdapterInboundRouteResult, { kind: "active" }>,
): boolean {
  return typeof route.authorization === "string"
    && route.authorization.length > 0
    && typeof route.username === "string"
    && route.targetKernelName === userKernelName(route.username)
    && Number.isSafeInteger(route.ownerUid)
    && route.ownerUid >= 0
    && Number.isSafeInteger(route.generation)
    && route.generation > 0
    && Number.isSafeInteger(route.linkGeneration)
    && route.linkGeneration > 0;
}

export class DiscordGatewayEntrypoint extends ScopedGatewayAdapterEntrypoint {
  protected readonly adapter = "discord";
}

export class TelegramGatewayEntrypoint extends ScopedGatewayAdapterEntrypoint {
  protected readonly adapter = "telegram";
}

export class WhatsAppGatewayEntrypoint extends ScopedGatewayAdapterEntrypoint {
  protected readonly adapter = "whatsapp";
}

export class TestGatewayEntrypoint extends ScopedGatewayAdapterEntrypoint {
  protected readonly adapter = "test";
}

async function cancelFrameRequestBody(frame: Frame, reason: string): Promise<void> {
  if (frame.type === "req" && frame.body && !frame.body.stream.locked) {
    await frame.body.stream.cancel(reason).catch(() => {});
  }
}
