import { ATPROTO_DID_PATH, serveAtprotoDid } from "../atproto-did";
import { buildOAuthClientMetadata } from "../oauth-http";
import {
  createPublicAssetFileSystem,
  matchPublicAssetPath,
  servePublicAssetRequest,
} from "../public-assets";
import { isWebSocketRequest } from "../shared/utils";
import {
  forgetInstallationRoute,
  getKernelByInstallationId,
  InstallationRouteUnavailable,
  resolveInstallationRoute,
} from "../installation/routing";
import { createInstallationStorage } from "../installation/storage";
import { createInstallationRipgit } from "../installation/ripgit";
import { buildGitProxyRequest, getBasicAuth, matchGitPath, publicGitResponse } from "../git";
import { isShipXrpcPath } from "../kernel/ships/xrpc";
import { matchPublicProfilePath, servePublicProfileRequest } from "../public-profiles";
import { limitShipCalls } from "../ship-call-limit";
import type { GatewayEnv } from "../runtime-env";
import { DEPLOYMENT_PRESENTATION_PATH, deploymentPresentation, deploymentPresentationScript } from "@humansandmachines/gsv/services/deployment";
import { matchHookPath, receiveHook } from "../event-hooks";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    const publicAssetMatch = matchPublicAssetPath(url.pathname);
    const gitMatch = matchGitPath(request);
    const websocketRequest = url.pathname === "/ws" && isWebSocketRequest(request);
    // Ship-to-Ship calls reach only an existing Ship; they never provision one.
    const federationPath = isShipXrpcPath(url.pathname);
    const profilePath = matchPublicProfilePath(url.pathname);
    const hookPath = matchHookPath(request);
    const browserAssetRequest = (
      request.method === "GET" || request.method === "HEAD"
    )
      && !publicAssetMatch
      && !gitMatch
      && url.pathname !== "/ws"
      && url.pathname !== "/oauth/callback"
      && url.pathname !== "/.well-known/oauth-client/gsv.json"
      && url.pathname !== ATPROTO_DID_PATH
      && !federationPath
      && !profilePath;

    // A public read may take a route Accounts gave in the last minute; a connection, git, a Ship's call or a sign-in callback asks again.
    const publicRead = (request.method === "GET" || request.method === "HEAD")
      && !websocketRequest
      && !gitMatch
      && !federationPath
      && url.pathname !== "/oauth/callback";
    let route;
    try {
      route = await resolveInstallationRoute(request, {
        allowProvisioning: websocketRequest || browserAssetRequest,
        cached: publicRead,
      });
    } catch (error) {
      if (!(error instanceof InstallationRouteUnavailable)) throw error;
      return new Response(error.message, { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
    }
    if (!route) {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname === DEPLOYMENT_PRESENTATION_PATH && request.method === "GET") {
      return Response.json(deploymentPresentation(env.GSV_PUBLIC_CONFIG), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/.well-known/oauth-client/gsv.json" && request.method === "GET") {
      return Response.json(buildOAuthClientMetadata(route.identity.canonicalOrigin), {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === ATPROTO_DID_PATH) {
      return serveAtprotoDid(request, env.PDS, route.identity.installationId);
    }

    if (publicAssetMatch) {
      const storage = createInstallationStorage(env.STORAGE, route.identity.installationId);
      const fs = createPublicAssetFileSystem({ STORAGE: storage });
      return servePublicAssetRequest(request, fs, publicAssetMatch);
    }
    // A flood of calls to a Ship stops here, before it reaches the Kernel.
    const shipCallsLimited = (federationPath || hookPath) && await limitShipCalls(request, env.SHIP_CALLS, route.identity.installationId);
    if (shipCallsLimited) return shipCallsLimited;
    const kernelDO = await getKernelByInstallationId(
      env.KERNEL,
      route.identity.installationId,
    );

    try {
      // look into this method
      await kernelDO.ensureInstallationIdentity(route.identity);
    } catch {
      // A retired or replaced Kernel refuses here; the next request asks Accounts for the hostname again.
      forgetInstallationRoute(request);
      console.error("[Gateway] Kernel installation identity check failed");
      return new Response("Installation unavailable", { status: 503 });
    }

    if (hookPath) return receiveHook(request, hookPath, kernelDO);

    if (profilePath) {
      const { primaryDomain } = deploymentPresentation(env.GSV_PUBLIC_CONFIG);
      return servePublicProfileRequest(request, profilePath, {
        page: () => kernelDO.getPublicProfile(),
        avatar: () => kernelDO.getPublicProfileAvatar(),
      }, primaryDomain ? `https://${primaryDomain}` : undefined);
    }

    if (federationPath) {
      return kernelDO.fetch(request);
    }

    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      return kernelDO.fetch(request);
    }

    if (websocketRequest) {
      return kernelDO.fetch(request);
    }

    if (gitMatch) {
      // Internal and unknown method/path combinations have no public caller.
      if (gitMatch.access === "refuse") {
        return new Response("Not Found", { status: 404 });
      }
      const basicAuth = getBasicAuth(request);
      const authorized = await kernelDO.authorizeGitHttp({
        owner: gitMatch.owner,
        repo: gitMatch.repo,
        write: gitMatch.access === "write",
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
        await buildGitProxyRequest(request, gitMatch, authorized.username),
      ));
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return withPublicDeploymentConfig(await env.ASSETS.fetch(request), env);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<GatewayEnv>;

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
