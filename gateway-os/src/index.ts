import { WorkerEntrypoint } from "cloudflare:workers";
import { isWebSocketRequest } from "./shared//utils";
import type {
  GatewayAdapterInterface,
} from "./adapter-interface";
import type { Frame } from "./protocol/frames";
import { getAgentByName } from "agents";
import { packageArtifactToWorkerCode, packageWorkerKey } from "./kernel/packages";
import type { PackageArtifact } from "./kernel/packages";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      return kernel.fetch(request);
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
      });

      if (!resolved.ok) {
        return new Response(resolved.message, { status: resolved.status });
      }

      const packageKey = packageWorkerKey({ manifest: { name: resolved.packageName }, artifact: resolved.artifact });

      const worker = env.LOADER.get(packageKey,
        () => packageArtifactToWorkerCode(resolved.artifact, {
          PACKAGE_NAME: resolved.packageName,
          PACKAGE_ID: resolved.packageId,
          PACKAGE_DO_NAME: resolved.packageDoName,
          PACKAGE_ROUTE_BASE: resolved.routeBase,
        }),
      ).getEntrypoint();

      return worker.fetch(buildPackageWorkerRequest(request, resolved));
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

type PackageAppSession = {
  username: string;
  token: string;
};

type ResolvedPackageRoute = {
  ok: true;
  packageId: string;
  packageName: string;
  packageDoName: string;
  routeBase: string;
  artifact: PackageArtifact;
  auth: {
    uid: number;
    username: string;
    capabilities: string[];
  };
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
  headers.set("x-gsv-package-do", resolved.packageDoName);

  return new Request(request, { headers });
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
