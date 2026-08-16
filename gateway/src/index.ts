import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AdapterInstallationContext,
  GatewayAdapterInterface,
} from "./adapter-interface";
import type {
  BinaryBody,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedMailGatewayService,
  ManagedTelegramGatewayService,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailReference,
  UnlinkManagedTelegramIdentityInput,
  UnlinkManagedTelegramIdentityResult,
} from "@humansandmachines/gsv/protocol";
import {
  cancelBinaryBody,
  isAdapterInstallationContext,
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
  getKernelByInstallationId,
  resolveInstallationRoute,
} from "./installation/routing";
import type { GatewayInstallationBindings } from "./installation/routing";
import {
  parseInstallationId,
  parseManagedInstallationId,
  SINGLETON_INSTALLATION_ID,
} from "./installation/identity";
import { managedInstallationWorkGate } from "./installation/lifecycle";
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

    const publicAssetMatch = matchPublicAssetPath(url.pathname);
    const gitMatch = matchGitPath(url);
    const websocketRequest = url.pathname === "/ws" && isWebSocketRequest(request);
    const browserAssetRequest = (
      request.method === "GET" || request.method === "HEAD"
    )
      && !publicAssetMatch
      && !gitMatch
      && url.pathname !== "/ws"
      && url.pathname !== "/oauth/callback"
      && url.pathname !== "/.well-known/oauth-client/gsv.json";

    // two possibilities:
    // 1. self-hosted GSV, has no multiple tenants so there's a singleton Kernel DO
    // 2. Managed GSV, there's one Kernel DO for each tenant and the routing is done through subdomains for tenant identifiers
    const route = await resolveInstallationRoute(request, {
      allowProvisioning: websocketRequest || browserAssetRequest,
    });
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

    if (websocketRequest) {
      return kernelDO.fetch(request);
    }

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

    if (request.method === "GET" || request.method === "HEAD") {
      return await env.ASSETS.fetch(request);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
export class GatewayEntrypoint
  extends WorkerEntrypoint<Env & GatewayInstallationBindings>
  implements GatewayAdapterInterface, ManagedMailGatewayService, ManagedTelegramGatewayService
{
  serviceFrame(frame: Frame): Promise<Frame | null>;
  serviceFrame(
    installation: AdapterInstallationContext,
    frame: Frame,
  ): Promise<Frame | null>;
  async serviceFrame(
    ...args:
      | [frame: Frame]
      | [installation: AdapterInstallationContext, frame: Frame]
  ): Promise<Frame | null> {
    const values = args as unknown[];
    try {
      if (values.length === 1) {
        return await routeAdapterServiceFrame(
          this.env,
          { installationId: SINGLETON_INSTALLATION_ID },
          requireAdapterServiceFrame(values[0]),
        );
      }
      if (values.length === 2 && isAdapterInstallationContext(values[0])) {
        return await routeAdapterServiceFrame(
          this.env,
          values[0],
          requireAdapterServiceFrame(values[1]),
        );
      }
      throw new Error("Gateway serviceFrame RPC arguments are invalid");
    } catch (error) {
      await Promise.all(
        adapterServiceFrameBodyCandidates(values)
          .map((body) => cancelBinaryBody(body, "Gateway service request failed")),
      );
      console.error("[GatewayEntrypoint] serviceFrame failed:", error);
      return null;
    }
  }

  async acceptManagedInboundMail(
    installation: AdapterInstallationContext,
    metadata: ManagedInboundMailMetadata,
    body: BinaryBody,
  ): Promise<ManagedInboundMailAccepted> {
    try {
      const installationId = resolveAdapterInstallationId(this.env, installation);
      if (this.env.INSTALLATION_DIRECTORY) {
        const gate = await managedInstallationWorkGate(this.env, installationId);
        if (!gate.allowed) throw new Error(gate.message);
      }
      const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
      return await kernel.acceptManagedInboundMail(metadata, body);
    } finally {
      if (!body.stream.locked) {
        await body.stream.cancel("Managed mail Gateway request completed").catch(() => {});
      }
    }
  }

  async completeManagedInboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedInboundMailCompletion,
  ): Promise<void> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    if (this.env.INSTALLATION_DIRECTORY) {
      const gate = await managedInstallationWorkGate(this.env, installationId);
      if (!gate.allowed) throw new Error(gate.message);
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    await kernel.completeManagedInboundMail(completion);
  }

  async claimManagedOutboundMail(
    installation: AdapterInstallationContext,
    reference: ManagedOutboundMailReference,
  ): Promise<ManagedOutboundMailClaimOutcome> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    if (this.env.INSTALLATION_DIRECTORY) {
      const gate = await managedInstallationWorkGate(this.env, installationId);
      if (!gate.allowed) throw new Error(gate.message);
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return await kernel.claimManagedOutboundMail(reference);
  }

  async completeManagedOutboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedOutboundMailCompletion,
  ): Promise<void> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (directory) {
      const result = await directory.resolveInstallation(installationId);
      if (!result.found) return;
      if (result.installationId !== installationId) {
        throw new Error("Managed installation identity does not match directory state");
      }
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    await kernel.completeManagedOutboundMail(completion);
  }

  async unlinkManagedTelegramIdentity(
    input: UnlinkManagedTelegramIdentityInput,
  ): Promise<UnlinkManagedTelegramIdentityResult> {
    if (!this.env.INSTALLATION_DIRECTORY) {
      throw new Error("Managed Telegram is not enabled");
    }
    const installationId = parseManagedInstallationId(input?.installationId);
    const directory = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!directory.found || directory.installationId !== installationId) {
      return { removed: false };
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return await kernel.unlinkManagedTelegramIdentity({ ...input, installationId });
  }
}

async function routeAdapterServiceFrame(
  bindings: Env & GatewayInstallationBindings,
  installation: AdapterInstallationContext,
  frame: Frame,
): Promise<Frame | null> {
  const body = binaryBodyCandidate((frame as { body?: unknown }).body);
  try {
    const installationId = resolveAdapterInstallationId(bindings, installation);
    if (bindings.INSTALLATION_DIRECTORY) {
      const gate = await managedInstallationWorkGate(bindings, installationId);
      if (!gate.allowed) {
        if (body && !body.stream.locked) {
          await body.stream.cancel(gate.message).catch(() => {});
        }
        return frame.type === "req"
          ? {
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: gate.code, message: gate.message },
            }
          : null;
      }
    }
    const kernel = await getKernelByInstallationId(bindings.KERNEL, installationId);
    return await kernel.serviceFrame(frame);
  } catch (error) {
    if (body && !body.stream.locked) {
      await body.stream.cancel("Gateway service request failed").catch(() => {});
    }
    console.error("[GatewayEntrypoint] serviceFrame failed:", error);
    return null;
  }
}

function requireAdapterServiceFrame(value: unknown): Frame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gateway serviceFrame frame is invalid");
  }
  const frame = value as Record<string, unknown>;
  if (frame.body !== undefined && !binaryBodyCandidate(frame.body)) {
    throw new Error("Gateway serviceFrame body is invalid");
  }
  if (frame.type === "req") {
    if (
      typeof frame.id !== "string"
      || typeof frame.call !== "string"
      || !("args" in frame)
    ) {
      throw new Error("Gateway serviceFrame frame is invalid");
    }
    return value as Frame;
  }
  if (frame.type === "res") {
    if (typeof frame.id !== "string" || typeof frame.ok !== "boolean") {
      throw new Error("Gateway serviceFrame frame is invalid");
    }
    return value as Frame;
  }
  if (frame.type === "sig" && typeof frame.signal === "string") {
    return value as Frame;
  }
  throw new Error("Gateway serviceFrame frame is invalid");
}

function adapterServiceFrameBodyCandidates(values: unknown[]): BinaryBody[] {
  const bodies = new Set<BinaryBody>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    try {
      const body = binaryBodyCandidate((value as { body?: unknown }).body);
      if (body) bodies.add(body);
    } catch {
      continue;
    }
  }
  return [...bodies];
}

function binaryBodyCandidate(value: unknown): BinaryBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return (value as { stream?: unknown }).stream instanceof ReadableStream
      ? value as BinaryBody
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveAdapterInstallationId(
  bindings: Env & GatewayInstallationBindings,
  installation: AdapterInstallationContext,
): string {
  if (bindings.INSTALLATION_DIRECTORY) {
    return parseManagedInstallationId(installation?.installationId);
  }
  const installationId = parseInstallationId(installation?.installationId);
  if (installationId !== SINGLETON_INSTALLATION_ID) {
    throw new Error("Adapter installation does not match standalone Gateway");
  }
  return installationId;
}
