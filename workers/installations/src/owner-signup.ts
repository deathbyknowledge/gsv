import { noStoreHeaders } from "./http";
import { configuredOriginAliases, deploymentPresentation, deploymentPresentationScript } from "@humansandmachines/gsv/services/deployment";
import type { InstallationOwnerEnvironment } from "./owner-service";

const PATH = "/owner/signup/";

export async function handleOwnerSignupRequest(request: Request, env: Pick<InstallationOwnerEnvironment, "GSV_ADMIN_ORIGIN" | "GSV_OWNER_SIGNUP_ORIGIN" | "GSV_OWNER_SIGNUP_ORIGIN_ALIASES" | "GSV_PUBLIC_CONFIG" | "ASSETS">, enabled: boolean): Promise<Response | null> {
  const url = new URL(request.url);
  const alias = env.GSV_OWNER_SIGNUP_ORIGIN;
  if (alias && url.origin !== alias && configuredOriginAliases(env.GSV_OWNER_SIGNUP_ORIGIN_ALIASES).includes(url.origin)) {
    if (!["GET", "HEAD"].includes(request.method) || !["/", PATH, PATH.slice(0, -1)].includes(url.pathname)) {
      return new Response("Not Found", { status: 404, headers: noStoreHeaders() });
    }
    return new Response(null, { status: 302, headers: noStoreHeaders({ location: new URL(`/${url.search}`, alias).href }) });
  }
  const dedicated = Boolean(alias && alias !== env.GSV_ADMIN_ORIGIN && url.origin === alias);
  if (dedicated && url.pathname.startsWith("/owner/api/")) return null;
  if (dedicated && (url.pathname === PATH || url.pathname === PATH.slice(0, -1))) {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Not Found", { status: 404, headers: noStoreHeaders() });
    return new Response(null, { status: 302, headers: noStoreHeaders({ location: `/${url.search}` }) });
  }
  const index = dedicated ? url.pathname === "/" : url.pathname === PATH;
  if (!index && url.pathname !== PATH.slice(0, -1) && !url.pathname.startsWith(PATH)) {
    return dedicated ? new Response("Not Found", { status: 404, headers: noStoreHeaders() }) : null;
  }
  if ((!dedicated && url.origin !== env.GSV_ADMIN_ORIGIN) || !["GET", "HEAD"].includes(request.method)) {
    return new Response("Not Found", { status: 404, headers: noStoreHeaders() });
  }
  if (!enabled || !env.ASSETS) return new Response("Signup is not configured", { status: 503, headers: noStoreHeaders() });
  if (url.pathname === PATH.slice(0, -1)) {
    return new Response(null, { status: 302, headers: noStoreHeaders({ location: PATH }) });
  }
  url.pathname = `/owner-signup/${index ? "index.html" : url.pathname.slice(PATH.length)}`;
  url.search = "";
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(asset.headers);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (index) headers.set("cache-control", "no-store");
  const response = new Response(asset.body, { status: asset.status, headers });
  if (!index || !headers.get("content-type")?.includes("text/html")) return response;
  const script = deploymentPresentationScript(deploymentPresentation(env.GSV_PUBLIC_CONFIG));
  return new HTMLRewriter().on("head", { element(element) { element.prepend(script, { html: true }); } }).transform(response);
}
