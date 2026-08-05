import gateway from "./index";

export { GatewayEntrypoint, Kernel, Process } from "./index";

const MANAGED_SESSION_COOKIE = "__Host-gsv-session";
const LOCAL_MANAGED_SESSION_COOKIE = "gsv-local-session";
const DEVELOPMENT_ACCOUNT_ASSET_PREFIX = "/__gsv/account/";
const DEVELOPMENT_ACCOUNT_INDEX = `${DEVELOPMENT_ACCOUNT_ASSET_PREFIX}account/index.html`;
const ACCOUNT_PAGE_PATHS = new Set([
  "/",
  "/verify",
  "/verify/",
  "/recover",
  "/recover/",
  "/telegram",
  "/telegram/",
  "/billing",
  "/billing/",
]);

type ManagedDevelopmentEnv = Env & {
  ACCOUNT_HTTP: Fetcher;
  GSV_ACCOUNT_ORIGIN: string;
};

/** Local-only host router. The production Wrangler config does not import it. */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === env.GSV_ACCOUNT_ORIGIN) {
      if (
        (request.method === "GET" || request.method === "HEAD")
        && ACCOUNT_PAGE_PATHS.has(url.pathname)
      ) {
        return await developmentAccountPage(request, env.ASSETS, env.GSV_ACCOUNT_ORIGIN);
      }
      if (
        (request.method === "GET" || request.method === "HEAD")
        && url.pathname.startsWith(DEVELOPMENT_ACCOUNT_ASSET_PREFIX)
      ) {
        return await env.ASSETS.fetch(request);
      }
      return withDevelopmentAccountHeaders(
        await env.ACCOUNT_HTTP.fetch(request),
        env.GSV_ACCOUNT_ORIGIN,
      );
    }
    if (!url.hostname.endsWith(".localhost")) {
      return new Response("Not Found", { status: 404 });
    }
    if (!hasValidDevelopmentWebSocketOrigin(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    const normalized = withDevelopmentCookie(request);
    return withDevelopmentSetCookie(await gateway.fetch(
      normalized as Parameters<typeof gateway.fetch>[0],
      env,
    ));
  },
} satisfies ExportedHandler<ManagedDevelopmentEnv>;

export function withDevelopmentCookie(request: Request): Request {
  const cookie = request.headers.get("cookie");
  if (!cookie) return request;
  const parts = cookie.split(";").map((part) => part.trim());
  const local = parts.find((part) => cookieName(part) === LOCAL_MANAGED_SESSION_COOKIE);
  if (!local) return request;
  const value = local.slice(local.indexOf("=") + 1).trim();
  const rewritten = parts
    .filter((part) => {
      const name = cookieName(part);
      return name !== LOCAL_MANAGED_SESSION_COOKIE && name !== MANAGED_SESSION_COOKIE;
    })
    .concat(`${MANAGED_SESSION_COOKIE}=${value}`)
    .join("; ");
  const headers = new Headers(request.headers);
  headers.set("cookie", rewritten);
  return new Request(request, { headers });
}

export function withDevelopmentSetCookie(response: Response): Response {
  const cookie = response.headers.get("set-cookie");
  if (!cookie?.startsWith(`${MANAGED_SESSION_COOKIE}=`)) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "set-cookie",
    `${LOCAL_MANAGED_SESSION_COOKIE}=${cookie.slice(MANAGED_SESSION_COOKIE.length + 1)}`
      .replace(/;\s*Secure(?=;|$)/gi, ""),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function hasValidDevelopmentWebSocketOrigin(request: Request): boolean {
  if (
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    || !request.headers.get("cookie")?.split(";").some(
      (part) => cookieName(part.trim()) === LOCAL_MANAGED_SESSION_COOKIE,
    )
  ) {
    return true;
  }
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === origin
      && origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function cookieName(part: string): string {
  const separator = part.indexOf("=");
  return separator === -1 ? "" : part.slice(0, separator).trim();
}

export function withDevelopmentAccountHeaders(
  response: Response,
  accountOrigin: string,
): Response {
  if (!response.headers.get("content-type")?.startsWith("text/html")) {
    return response;
  }
  const accountUrl = new URL(accountOrigin);
  const port = accountUrl.port ? `:${accountUrl.port}` : "";
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self' https://challenges.cloudflare.com",
      "font-src 'self'",
      `form-action 'self' ${accountUrl.protocol}//*.localhost${port}`,
      "frame-ancestors 'none'",
      "frame-src https://challenges.cloudflare.com",
      "img-src 'self' data:",
      "manifest-src 'self'",
      "object-src 'none'",
      "script-src 'self' https://challenges.cloudflare.com",
      "style-src 'self'",
      "worker-src 'none'",
    ].join("; "));
  }
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", [
    "camera=()",
    "geolocation=()",
    "microphone=()",
    "payment=()",
    "publickey-credentials-create=(self)",
    "publickey-credentials-get=(self)",
  ].join(", "));
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function developmentAccountPage(
  request: Request,
  assets: Fetcher,
  accountOrigin: string,
): Promise<Response> {
  const assetUrl = new URL(DEVELOPMENT_ACCOUNT_INDEX, request.url);
  const asset = await assets.fetch(new Request(assetUrl, { method: "GET" }));
  if (!asset.ok) return asset;
  const response = withDevelopmentAccountHeaders(asset, accountOrigin);
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
