import { WorkerEntrypoint } from "cloudflare:workers";
import { isWebSocketRequest } from "./shared//utils";
import type {
  GatewayAdapterInterface,
} from "./adapter-interface";
import type { Frame } from "./protocol/frames";
import { getAgentByName } from "agents";
import type { AppFrameContext, PackageAppProps } from "./protocol/app-frame";
import { packageArtifactToWorkerCode, packageWorkerKey } from "./kernel/packages";
import type { PackageArtifact } from "./kernel/packages";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";
export { KernelBinding } from "./kernel/packages";
export { PackageBinding } from "./kernel/packages";

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

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      return kernel.fetch(request);
    }

    const gitMatch = matchGitPath(url);
    if (gitMatch) {
      const basicAuth = getBasicAuth(request);
      if (!basicAuth) {
        return basicAuthChallenge("Authentication required");
      }

      const kernel = await getAgentByName(env.KERNEL, "singleton");
      const authorized = await kernel.authorizeGitHttp({
        owner: gitMatch.owner,
        repo: gitMatch.repo,
        write: gitMatch.write,
        username: basicAuth.username,
        credential: basicAuth.credential,
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
          env.RIPGIT_INTERNAL_KEY,
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
      ).getEntrypoint(undefined, {
        props: {
          appFrame: resolved.appFrame,
          packageDoName: resolved.packageDoName,
          kernel: ctx.exports.KernelBinding({
            props: {
              appFrame: resolved.appFrame,
            },
          }),
          package: ctx.exports.PackageBinding({
            props: {
              appFrame: resolved.appFrame,
              packageDoName: resolved.packageDoName,
            },
          }),
        } satisfies PackageAppProps,
      });

      return worker.fetch(buildPackageWorkerRequest(request, resolved));
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

type ResolvedPackageRoute = {
  ok: true;
  packageId: string;
  packageName: string;
  packageDoName: string;
  routeBase: string;
  artifact: PackageArtifact;
  appFrame: AppFrameContext;
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
  headers.set("x-gsv-package-do", resolved.packageDoName);

  return new Request(request, { headers });
}

async function buildGitProxyRequest(
  request: Request,
  gitMatch: GitPathMatch,
  internalKey: string | undefined,
  username: string,
): Promise<Request> {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`https://ripgit/${encodeURIComponent(gitMatch.owner)}/${encodeURIComponent(gitMatch.repo)}/${gitMatch.suffix}`);
  targetUrl.search = sourceUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set("x-ripgit-actor-name", username);
  if (internalKey) {
    headers.set("x-ripgit-internal-key", internalKey);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
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
