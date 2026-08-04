import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AdapterInstallationContext,
  GatewayAdapterInterface,
} from "./adapter-interface";
import type {
  ManagedGatewayProvisioningInterface,
  ProvisionInstallationInput,
  ProvisionInstallationResult,
} from "@humansandmachines/gsv/protocol";
import type { Frame } from "./protocol/frames";
import { buildOAuthClientMetadata } from "./oauth-http";
import {
  createPublicAssetFileSystem,
  matchPublicAssetPath,
  servePublicAssetRequest,
} from "./public-assets";
import { isWebSocketRequest } from "./shared/utils";
import {
  getGatewayInstallationRoutingSource,
  getKernelByInstallationId,
  getStandaloneServiceInstallationId,
  installationIdentityInput,
  resolveInstallationRoute,
  type TrustedInstallationRoute,
} from "./installation/routing";
import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseInstallationId,
} from "./installation/identity";
import type { Kernel } from "./kernel/do";
import { createInstallationStorage } from "./installation/storage";
import {
  createInstallationRipgit,
  removeUntrustedRipgitInstallationHeader,
} from "./installation/ripgit";
import { parseProvisionInstallationInput } from "./managed/provisioning";
import {
  clearManagedSessionCookie,
  managedSessionSetCookie,
  readManagedSessionCookie,
} from "./managed/session-cookie";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/auth/handoff") {
      return await handleManagedLoginHandoff(request, env);
    }

    if (url.pathname === "/auth/logout") {
      return await handleManagedLogout(request, env);
    }

    if (url.pathname === "/.well-known/oauth-client/gsv.json" && request.method === "GET") {
      const resolved = await resolveGatewayInstallation(request, env);
      if (!resolved.ok) return resolved.response;
      return Response.json(buildOAuthClientMetadata(resolved.route.identity.canonicalOrigin), {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const resolved = await resolveGatewayKernel(request, env);
      if (!resolved.ok) return resolved.response;
      return resolved.kernel.fetch(request);
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const resolved = await resolveGatewayKernel(request, env);
      if (!resolved.ok) return resolved.response;
      return resolved.kernel.fetch(request);
    }

    if (isRetiredCliDownloadPath(url.pathname)) {
      return new Response("CLI downloads moved to https://install.gsv.space", {
        status: 410,
        headers: { "cache-control": "no-store" },
      });
    }

    const publicAssetMatch = matchPublicAssetPath(url.pathname);
    if (publicAssetMatch) {
      const resolved = await resolveGatewayInstallation(request, env);
      if (!resolved.ok) return resolved.response;
      const storage = createInstallationStorage(
        env.STORAGE,
        resolved.route.identity.installationId,
      );
      return servePublicAssetRequest(
        request,
        createPublicAssetFileSystem({ STORAGE: storage }),
        publicAssetMatch,
      );
    }

    const gitMatch = matchGitPath(url);
    if (gitMatch) {
      const basicAuth = getBasicAuth(request);
      const resolved = await resolveGatewayKernel(request, env);
      if (!resolved.ok) return resolved.response;
      const { kernel, route } = resolved;
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

type InstallationResolution =
  | { ok: true; route: TrustedInstallationRoute }
  | { ok: false; response: Response };

type KernelResolution =
  | {
      ok: true;
      route: TrustedInstallationRoute;
      kernel: DurableObjectStub<Kernel>;
    }
  | { ok: false; response: Response };

async function resolveGatewayInstallation(
  request: Request,
  env: Env,
): Promise<InstallationResolution> {
  try {
    const route = await resolveInstallationRoute(
      request,
      getGatewayInstallationRoutingSource(request, env),
    );
    if (!route) {
      return { ok: false, response: new Response("Not Found", { status: 404 }) };
    }
    return { ok: true, route };
  } catch {
    console.error("[Gateway] Installation resolution failed");
    return {
      ok: false,
      response: new Response("Installation routing unavailable", { status: 503 }),
    };
  }
}

async function resolveGatewayKernel(
  request: Request,
  env: Env,
): Promise<KernelResolution> {
  const resolved = await resolveGatewayInstallation(request, env);
  if (!resolved.ok) return resolved;

  try {
    const kernel = await getKernelByInstallationId(
      env.KERNEL,
      resolved.route.identity.installationId,
    );
    await kernel.ensureInstallationIdentity(
      installationIdentityInput(resolved.route.identity),
    );
    return { ok: true, route: resolved.route, kernel };
  } catch {
    console.error("[Gateway] Kernel installation identity check failed");
    return {
      ok: false,
      response: new Response("Installation unavailable", { status: 503 }),
    };
  }
}

const RETIRED_CLI_DOWNLOAD_PATH = "/public/gsv/downloads/cli";

function isRetiredCliDownloadPath(pathname: string): boolean {
  return pathname === RETIRED_CLI_DOWNLOAD_PATH
    || pathname.startsWith(`${RETIRED_CLI_DOWNLOAD_PATH}/`);
}

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
    write: suffix === "git-receive-pack"
      || (suffix === "info/refs" && service === "git-receive-pack"),
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

async function buildGitProxyRequest(
  request: Request,
  gitMatch: GitPathMatch,
  username: string | null,
): Promise<Request> {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(
    `https://ripgit/${encodeURIComponent(gitMatch.owner)}/${encodeURIComponent(gitMatch.repo)}/${gitMatch.suffix}`,
  );
  targetUrl.search = sourceUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  removeUntrustedRipgitInstallationHeader(headers);
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

export class GatewayEntrypoint
  extends WorkerEntrypoint<Env>
  implements GatewayAdapterInterface, ManagedGatewayProvisioningInterface
{
  async provisionInstallation(
    rawInput: ProvisionInstallationInput,
  ): Promise<ProvisionInstallationResult> {
    if (getStandaloneServiceInstallationId(this.env)) {
      throw new Error("Managed provisioning is not enabled");
    }
    const input = parseProvisionInstallationInput(rawInput);
    const kernel = await getKernelByInstallationId(
      this.env.KERNEL,
      input.installation.installationId,
    );
    await kernel.ensureInstallationIdentity(input.installation);
    return await kernel.provisionManagedInstallation(input);
  }

  async serviceFrame(
    installation: AdapterInstallationContext,
    frame: Frame,
  ): Promise<Frame | null> {
    const body = "body" in frame ? frame.body : undefined;
    try {
      const installationId = parseInstallationId(installation?.installationId);
      const standaloneInstallationId = getStandaloneServiceInstallationId(this.env);
      if (standaloneInstallationId) {
        if (installationId !== standaloneInstallationId) {
          throw new Error("Adapter installation does not match standalone Gateway");
        }
      } else if (installationId === LEGACY_STANDALONE_INSTALLATION_ID) {
        throw new Error("Managed adapter requests cannot address singleton");
      }
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

const MANAGED_BROWSER_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HANDOFF_BODY_BYTES = 2_048;

async function handleManagedLoginHandoff(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const source = getGatewayInstallationRoutingSource(request, env);
  if (source.kind !== "managed") {
    return new Response("Managed login is not available", { status: 404 });
  }
  if (!hasExpectedOrigin(request, managedAccountOrigin(env))) {
    return new Response("Forbidden", { status: 403 });
  }

  let token: string;
  try {
    token = await readHandoffToken(request);
  } catch {
    return new Response("Invalid login handoff", { status: 400 });
  }

  const resolved = await resolveGatewayKernel(request, env);
  if (!resolved.ok) return resolved.response;
  try {
    const verification = await source.directory.verifyLoginHandoff(
      token,
      resolved.route.requestedHostname,
    );
    if (
      !verification.ok
      || verification.installationId !== resolved.route.identity.installationId
      || !Number.isSafeInteger(verification.localUid)
      || verification.localUid < 1000
    ) {
      return new Response("Invalid or expired login handoff", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }
    const session = await resolved.kernel.createManagedLoginSession({
      principalId: verification.principalId,
      localUid: verification.localUid,
      expiresAt: Date.now() + MANAGED_BROWSER_SESSION_MS,
    });
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": managedSessionSetCookie(session.token, session.expiresAt),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch {
    console.error("[Gateway] Managed login handoff failed");
    return new Response("Login unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}

async function handleManagedLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const source = getGatewayInstallationRoutingSource(request, env);
  if (source.kind !== "managed") {
    return new Response("Managed login is not available", { status: 404 });
  }
  const expectedOrigin = new URL(request.url).origin;
  if (!hasExpectedOrigin(request, expectedOrigin)) {
    return new Response("Forbidden", { status: 403 });
  }
  const resolved = await resolveGatewayKernel(request, env);
  if (!resolved.ok) return resolved.response;
  const token = readManagedSessionCookie(request.headers.get("cookie"));
  if (token) {
    await resolved.kernel.revokeManagedLoginSession(token).catch(() => false);
  }
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": clearManagedSessionCookie(),
      "cache-control": "no-store",
    },
  });
}

async function readHandoffToken(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HANDOFF_BODY_BYTES) {
    throw new Error("handoff body is too large");
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new Error("handoff content type is invalid");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_HANDOFF_BODY_BYTES) {
    throw new Error("handoff body is too large");
  }
  const params = new URLSearchParams(body);
  const values = params.getAll("token");
  if (values.length !== 1 || !values[0] || values[0].length > 512) {
    throw new Error("handoff token is invalid");
  }
  return values[0];
}

function managedAccountOrigin(env: Env): string {
  const value = (env as Env & { GSV_ACCOUNT_ORIGIN?: string }).GSV_ACCOUNT_ORIGIN;
  return value?.trim() || "https://accounts.gsv.space";
}

function hasExpectedOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}
