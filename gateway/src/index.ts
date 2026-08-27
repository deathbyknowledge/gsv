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
  ManagedAdapterGatewayService,
  ManagedTelegramGatewayService,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailReference,
  UnlinkManagedTelegramIdentityInput,
  UnlinkManagedTelegramIdentityResult,
  UnlinkManagedAdapterIdentityInput,
  UnlinkManagedAdapterIdentityResult,
} from "@humansandmachines/gsv/protocol";
import type { MailGatewayService } from "@humansandmachines/gsv/services/mail";
import {
  adapterGatewayFrameSchema,
  adapterInstallationContextSchema,
  binaryBodySchema,
  cancelBinaryBody,
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
import * as z from "zod/mini";
import type { ServicePeerProfile } from "./kernel/peer";
import { isFederationPublicPath } from "./kernel/federation";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";
export { Conversation } from "./conversation/do";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    const publicAssetMatch = matchPublicAssetPath(url.pathname);
    const gitMatch = matchGitPath(url);
    const websocketRequest = url.pathname === "/ws" && isWebSocketRequest(request);
    const federationPath = isFederationPublicPath(url.pathname);
    const browserAssetRequest = (
      request.method === "GET" || request.method === "HEAD"
    )
      && !publicAssetMatch
      && !gitMatch
      && url.pathname !== "/ws"
      && url.pathname !== "/oauth/callback"
      && url.pathname !== "/.well-known/oauth-client/gsv.json"
      && !federationPath;

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

const ADAPTER_SERVICE_CALLS = ["adapter.inbound", "adapter.state.update"] as const;
const LEGACY_ADAPTER_IDS = new Set(["telegram", "whatsapp", "discord", "test"]);
const legacyAdapterServiceArgsSchema = z.object({
  adapter: z.string(),
});
const adapterServicePeerProfileSchema = z.object({
  id: z.string().check(
    z.minLength(1),
    z.maxLength(64),
    z.regex(/^[a-z][a-z0-9-]*$/),
  ),
  calls: z.array(z.enum(ADAPTER_SERVICE_CALLS)).check(
    z.minLength(1),
    z.maxLength(ADAPTER_SERVICE_CALLS.length),
  ),
});

abstract class AdapterServiceEntrypoint<Props>
  extends WorkerEntrypoint<Env & GatewayInstallationBindings, Props>
  implements GatewayAdapterInterface
{
  protected abstract resolveServicePeerProfile(frame: Frame): ServicePeerProfile;

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
    try {
      if (args.length === 1) {
        const frame = requireAdapterServiceFrame(args[0]);
        return await routeAdapterServiceFrame(
          this.env,
          { installationId: SINGLETON_INSTALLATION_ID },
          this.resolveServicePeerProfile(frame),
          frame,
        );
      }
      const installation = adapterInstallationContextSchema.safeParse(args[0]);
      if (args.length === 2 && installation.success) {
        const frame = requireAdapterServiceFrame(args[1]);
        return await routeAdapterServiceFrame(
          this.env,
          installation.data,
          this.resolveServicePeerProfile(frame),
          frame,
        );
      }
      throw new Error("Gateway serviceFrame RPC arguments are invalid");
    } catch (error) {
      await Promise.all(
        adapterServiceFrameBodyCandidates(args)
          .map((body) => cancelBinaryBody(body, "Gateway service request failed")),
      );
      console.error("[GatewayEntrypoint] serviceFrame failed:", error);
      return null;
    }
  }
}

export class GatewayEntrypoint
  extends AdapterServiceEntrypoint<Record<never, never>>
  implements MailGatewayService, ManagedTelegramGatewayService
{
  protected override resolveServicePeerProfile(frame: Frame): ServicePeerProfile {
    return resolveLegacyAdapterServicePeerProfile(frame);
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

export class AdapterGatewayEntrypoint
  extends AdapterServiceEntrypoint<ServicePeerProfile>
  implements ManagedAdapterGatewayService
{
  protected override resolveServicePeerProfile(): ServicePeerProfile {
    const parsed = adapterServicePeerProfileSchema.safeParse(this.ctx.props);
    if (!parsed.success || new Set(parsed.data.calls).size !== parsed.data.calls.length) {
      throw new Error("Adapter service binding props are invalid");
    }
    return parsed.data;
  }

  async unlinkManagedAdapterIdentity(
    installation: AdapterInstallationContext,
    input: UnlinkManagedAdapterIdentityInput,
  ): Promise<UnlinkManagedAdapterIdentityResult> {
    const directory = this.env.INSTALLATION_DIRECTORY;
    if (!directory) throw new Error("Managed adapter pairing is not enabled");
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const resolved = await directory.resolveInstallation(installationId);
    if (!resolved.found || resolved.installationId !== installationId) {
      return { removed: false };
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return await kernel.unlinkManagedAdapterIdentity(
      this.resolveServicePeerProfile().id,
      input,
    );
  }
}

async function routeAdapterServiceFrame(
  bindings: Env & GatewayInstallationBindings,
  installation: AdapterInstallationContext,
  profile: ServicePeerProfile,
  frame: Frame,
): Promise<Frame | null> {
  const body = adapterServiceFrameBody(frame);
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
    const kernelStub: unknown = await getKernelByInstallationId(bindings.KERNEL, installationId);
    // SAFETY: this namespace is generated from Kernel; the narrow view avoids
    // recursively expanding every unrelated RPC method in Cloudflare's stub type.
    const kernel = kernelStub as {
      peerFrame(profile: ServicePeerProfile, frame: Frame): Promise<Frame | null>;
    };
    return await kernel.peerFrame(profile, frame);
  } catch (error) {
    if (body && !body.stream.locked) {
      await body.stream.cancel("Gateway service request failed").catch(() => {});
    }
    console.error("[GatewayEntrypoint] serviceFrame failed:", error);
    return null;
  }
}

function requireAdapterServiceFrame(value: Frame): Frame {
  const parsed = adapterGatewayFrameSchema.safeParse(value);
  if (!parsed.success) throw new Error("Gateway serviceFrame frame is invalid");
  return value;
}

function resolveLegacyAdapterServicePeerProfile(frame: Frame): ServicePeerProfile {
  if (frame.type !== "req") {
    throw new Error("Legacy adapter service bindings accept only requests");
  }
  const args = legacyAdapterServiceArgsSchema.safeParse(frame.args);
  const adapter = args.success ? args.data.adapter.trim().toLowerCase() : "";
  if (!LEGACY_ADAPTER_IDS.has(adapter)) {
    throw new Error("Legacy adapter service identity is invalid");
  }
  return { id: adapter, calls: ADAPTER_SERVICE_CALLS };
}

type AdapterServiceRpcArgument = AdapterInstallationContext | Frame;
const adapterServiceFrameBodySchema = z.object({ body: binaryBodySchema });

function adapterServiceFrameBodyCandidates(
  values: readonly AdapterServiceRpcArgument[],
): BinaryBody[] {
  const bodies = new Set<BinaryBody>();
  for (const value of values) {
    const body = adapterServiceFrameBody(value);
    if (body) bodies.add(body);
  }
  return [...bodies];
}

function adapterServiceFrameBody(
  value: AdapterServiceRpcArgument,
): BinaryBody | undefined {
  const parsed = adapterServiceFrameBodySchema.safeParse(value);
  return parsed.success ? parsed.data.body : undefined;
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
