import gateway from "./index";

export { GatewayEntrypoint, Kernel, Process } from "./index";

const MANAGED_SESSION_COOKIE = "__Host-gsv-session";
const LOCAL_MANAGED_SESSION_COOKIE = "gsv-local-session";

type ManagedDevelopmentEnv = Env & {
  ACCOUNT_HTTP: Fetcher;
  GSV_ACCOUNT_ORIGIN: string;
};

/** Local-only host router. The production Wrangler config does not import it. */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === env.GSV_ACCOUNT_ORIGIN) {
      return await env.ACCOUNT_HTTP.fetch(request);
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
