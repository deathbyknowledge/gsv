import { WorkerEntrypoint } from "cloudflare:workers";
import type { GatewayAdapterInterface } from "./adapter-interface";
import type { Frame } from "./protocol/frames";
import { buildOAuthClientMetadata } from "./oauth-http";
import {
  createPublicAssetFileSystem,
  matchPublicAssetPath,
  servePublicAssetRequest,
} from "./public-assets";
import { isWebSocketRequest } from "./shared/utils";
import {
  getKernelByInstallationId,
  resolveInstallationRoute,
} from "./installation/routing";
import type { GatewayInstallationBindings } from "./installation/routing";
import { SINGLETON_INSTALLATION_ID } from "./installation/identity";
import { createInstallationStorage } from "./installation/storage";
import { createInstallationRipgit } from "./installation/ripgit";
import { buildGitProxyRequest, getBasicAuth, matchGitPath } from "./git";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    // two possibilities:
    // 1. self-hosted GSV, has no multiple tenants so there's a singleton Kernel DO
    // 2. Managed GSV, there's one Kernel DO for each tenant and the routing is done through subdomains for tenant identifiers
    const route = await resolveInstallationRoute(request);
    if (!route) {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname === "/.well-known/oauth-client/gsv.json" && request.method === "GET") {
      return Response.json(buildOAuthClientMetadata(route.identity.canonicalOrigin), {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    const publicAssetMatch = matchPublicAssetPath(url.pathname);
    if (publicAssetMatch) {
      const storage = createInstallationStorage(env.STORAGE, route.identity.installationId);
      const fs = createPublicAssetFileSystem({ STORAGE: storage });
      return servePublicAssetRequest(request, fs, publicAssetMatch);
    }
    const kernelDO = await getKernelByInstallationId(
      env.KERNEL,
      route.identity.installationId,
    );

    try {
      // look into this method
      await kernelDO.ensureInstallationIdentity(route.identity);
    } catch {
      console.error("[Gateway] Kernel installation identity check failed");
      return new Response("Installation unavailable", { status: 503 });
    }

    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      return kernelDO.fetch(request);
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      return kernelDO.fetch(request);
    }

    const gitMatch = matchGitPath(url);
    if (gitMatch) {
      const basicAuth = getBasicAuth(request);
      const authorized = await kernelDO.authorizeGitHttp({
        owner: gitMatch.owner,
        repo: gitMatch.repo,
        write: gitMatch.write,
        username: basicAuth?.username,
        credential: basicAuth?.credential,
      });
      if (!authorized.ok) {
        return authorized.status === 401
          ? new Response(authorized.message, {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="gsv"' },
          })
          : new Response(authorized.message, { status: authorized.status });
      }

      return createInstallationRipgit(
        env.RIPGIT,
        route.identity.installationId,
      ).fetch(
        await buildGitProxyRequest(request, gitMatch, authorized.username),
      );
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
export class GatewayEntrypoint
  extends WorkerEntrypoint<Env & GatewayInstallationBindings>
  implements GatewayAdapterInterface
{
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    const body = "body" in frame ? frame.body : undefined;
    try {
      if (this.env.INSTALLATION_DIRECTORY) {
        throw new Error("Managed adapter requests require installation-scoped routing");
      }
      const installationId = SINGLETON_INSTALLATION_ID;
      const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
      return await kernel.serviceFrame(frame);
    } catch (error) {
      if (body && !body.stream.locked) {
        await body.stream.cancel("Gateway service request failed").catch(() => {});
      }
      console.error("[GatewayEntrypoint] serviceFrame failed:", error);
      return null;
    }
  }
}
