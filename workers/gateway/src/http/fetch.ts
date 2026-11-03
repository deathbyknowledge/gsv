import { ATPROTO_DID_PATH, serveAtprotoDid } from "../atproto-did";
import { buildOAuthClientMetadata } from "../oauth-http";
import {
  createPublicAssetFileSystem,
  matchPublicAssetPath,
  servePublicAssetRequest,
  type PublicAssetMatch,
} from "../public-assets";
import { isWebSocketRequest } from "../shared/utils";
import {
  forgetInstallationRoute,
  getKernelByInstallationId,
  InstallationRouteUnavailable,
  resolveInstallationRoute,
  type InstallationRoute,
} from "../installation/routing";
import { createInstallationStorage } from "../installation/storage";
import { createInstallationRipgit } from "../installation/ripgit";
import { buildGitProxyRequest, getBasicAuth, matchGitPath, publicGitResponse, type GitPathMatch } from "../git";
import { isShipXrpcPath } from "../kernel/ships/xrpc";
import type { Kernel } from "../kernel/do";
import { matchPublicProfilePath, servePublicProfileRequest, type PublicProfilePath } from "../public-profiles";
import { limitShipCalls } from "../ship-call-limit";
import type { GatewayEnv } from "../runtime-env";
import { DEPLOYMENT_PRESENTATION_PATH, deploymentPresentation, deploymentPresentationScript } from "@humansandmachines/gsv/services/deployment";
import { matchHookPath, receiveHook, type HookPath } from "../event-hooks";

/** Requests the Gateway answers from the installation's route, without its Kernel. */
type EdgeRoute =
  | { kind: "presentation" }
  | { kind: "oauth-client" }
  | { kind: "did" }
  | { kind: "public-asset"; match: PublicAssetMatch }
  | { kind: "app" };

/** Requests only the installation's Kernel can answer. */
type KernelRoute =
  | { kind: "hook"; match: HookPath }
  | { kind: "profile"; path: PublicProfilePath }
  | { kind: "federation" }
  | { kind: "oauth-callback" }
  | { kind: "websocket" }
  | { kind: "git"; match: GitPathMatch };

type GatewayRoute = EdgeRoute | KernelRoute;

/**
 * What each route may reach. A `provisioning` route also serves a Ship still
 * being set up. A `fresh` route asks Accounts on every request; any other
 * read may take a route Accounts gave within the last minute.
 */
const ROUTE_POLICY: Record<GatewayRoute["kind"], { provisioning: boolean; fresh: boolean }> = {
  presentation: { provisioning: true, fresh: false },
  "oauth-client": { provisioning: false, fresh: false },
  did: { provisioning: false, fresh: false },
  "public-asset": { provisioning: false, fresh: false },
  app: { provisioning: true, fresh: false },
  hook: { provisioning: false, fresh: true },
  profile: { provisioning: false, fresh: false },
  // Ship-to-Ship calls reach only an existing Ship; they never provision one.
  federation: { provisioning: false, fresh: true },
  "oauth-callback": { provisioning: false, fresh: true },
  websocket: { provisioning: true, fresh: true },
  git: { provisioning: false, fresh: true },
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    // A request no route serves never reaches Accounts, so it allocates nothing.
    const target = matchRoute(request, url);
    if (!target) return new Response("Not Found", { status: 404 });

    let route: InstallationRoute | null;
    try {
      route = await resolveInstallationRoute(request, {
        allowProvisioning: ROUTE_POLICY[target.kind].provisioning,
        cached: isRead(request) && !ROUTE_POLICY[target.kind].fresh,
      });
    } catch (error) {
      if (!(error instanceof InstallationRouteUnavailable)) throw error;
      return new Response(error.message, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
    }
    if (!route) {
      return new Response("Not Found", { status: 404 });
    }

    switch (target.kind) {
      case "presentation":
        return Response.json(deploymentPresentation(env.GSV_PUBLIC_CONFIG), {
          headers: { "cache-control": "no-store" },
        });
      case "oauth-client":
        return Response.json(buildOAuthClientMetadata(route.identity.canonicalOrigin), {
          headers: {
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        });
      case "did":
        return serveAtprotoDid(request, env.PDS, route.identity.installationId);
      case "public-asset": {
        const storage = createInstallationStorage(env.STORAGE, route.identity.installationId);
        const fs = createPublicAssetFileSystem({ STORAGE: storage });
        return servePublicAssetRequest(request, fs, target.match);
      }
      case "app":
        // The web app's files are the same for every Ship; its connection meets the Kernel.
        return withPublicDeploymentConfig(await env.ASSETS.fetch(request), env);
      default:
        return await serveFromKernel(request, env, route, target);
    }
  },
} satisfies ExportedHandler<GatewayEnv>;

function matchRoute(request: Request, url: URL): GatewayRoute | null {
  if (url.pathname === DEPLOYMENT_PRESENTATION_PATH && request.method === "GET") return { kind: "presentation" };
  if (url.pathname === "/.well-known/oauth-client/gsv.json" && request.method === "GET") return { kind: "oauth-client" };
  if (url.pathname === ATPROTO_DID_PATH) return { kind: "did" };
  const publicAsset = matchPublicAssetPath(url.pathname);
  if (publicAsset) return { kind: "public-asset", match: publicAsset };
  const hook = matchHookPath(request);
  if (hook) return { kind: "hook", match: hook };
  const profile = matchPublicProfilePath(url.pathname);
  if (profile) return { kind: "profile", path: profile };
  if (isShipXrpcPath(url.pathname)) return { kind: "federation" };
  if (url.pathname === "/oauth/callback" && request.method === "GET") return { kind: "oauth-callback" };
  if (url.pathname === "/ws" && isWebSocketRequest(request)) return { kind: "websocket" };
  const git = matchGitPath(request);
  if (git) return { kind: "git", match: git };
  return isRead(request) ? { kind: "app" } : null;
}

function isRead(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

async function serveFromKernel(
  request: Request,
  env: GatewayEnv,
  route: InstallationRoute,
  target: KernelRoute,
): Promise<Response> {
  // A flood of calls to a Ship stops here, before it reaches the Kernel.
  if (target.kind === "federation" || target.kind === "hook") {
    const limited = await limitShipCalls(request, env.SHIP_CALLS, route.identity.installationId);
    if (limited) return limited;
  }
  const kernel = await getKernelByInstallationId(env.KERNEL, route.identity.installationId);

  try {
    // look into this method
    await kernel.ensureInstallationIdentity(route.identity);
  } catch {
    // A retired or replaced Kernel refuses here; the next request asks Accounts for the hostname again.
    forgetInstallationRoute(request);
    console.error("[Gateway] Kernel installation identity check failed");
    return new Response("Installation unavailable", { status: 503 });
  }

  switch (target.kind) {
    case "hook":
      return receiveHook(request, target.match, kernel);
    case "profile": {
      const { primaryDomain } = deploymentPresentation(env.GSV_PUBLIC_CONFIG);
      return servePublicProfileRequest(request, target.path, {
        page: () => kernel.getPublicProfile(),
        avatar: () => kernel.getPublicProfileAvatar(),
      }, primaryDomain ? `https://${primaryDomain}` : undefined);
    }
    case "federation":
    case "oauth-callback":
    case "websocket":
      return kernel.fetch(request);
    case "git":
      return await serveGit(request, env, route, kernel, target.match);
  }
}

async function serveGit(
  request: Request,
  env: GatewayEnv,
  route: InstallationRoute,
  kernel: DurableObjectStub<Kernel>,
  match: GitPathMatch,
): Promise<Response> {
  // Internal and unknown method/path combinations have no public caller.
  if (match.access === "refuse") {
    return new Response("Not Found", { status: 404 });
  }
  const basicAuth = getBasicAuth(request);
  const authorized = await kernel.authorizeGitHttp({
    owner: match.owner,
    repo: match.repo,
    write: match.access === "write",
    username: basicAuth?.username,
    credential: basicAuth?.credential,
    address: request.headers.get("CF-Connecting-IP"),
  });
  if (!authorized.ok) {
    if (authorized.status === 401) {
      return new Response(authorized.message, {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="gsv"' },
      });
    }
    return new Response(authorized.message, {
      status: authorized.status,
      headers: authorized.retryAfterSeconds === undefined ? undefined : { "Retry-After": String(authorized.retryAfterSeconds) },
    });
  }

  return publicGitResponse(await createInstallationRipgit(
    env.RIPGIT,
    route.identity.installationId,
  ).fetch(
    await buildGitProxyRequest(request, match, authorized.username),
  ));
}

function withPublicDeploymentConfig(response: Response, env: GatewayEnv): Response {
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const script = deploymentPresentationScript(deploymentPresentation(env.GSV_PUBLIC_CONFIG));
  const headers = new Headers(response.headers);
  headers.delete("etag");
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new HTMLRewriter().on("head", { element(element) { element.prepend(script, { html: true }); } })
    .transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}
