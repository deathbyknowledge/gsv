import { WorkerEntrypoint } from "cloudflare:workers";
import * as z from "zod/mini";
import type {
  AdapterInstallationContext,
  GatewayAdapterInterface,
} from "../adapter-interface";
import type {
  AdapterLinkedPeerContext,
  BinaryBody,
  ManagedAdapterGatewayService,
  UnlinkManagedAdapterIdentityInput,
  UnlinkManagedAdapterIdentityResult,
} from "@humansandmachines/gsv/protocol";
import {
  adapterGatewayFrameSchema,
  adapterInstallationContextSchema,
  adapterLinkedPeerContextSchema,
  binaryBodySchema,
  cancelBinaryBody,
} from "@humansandmachines/gsv/protocol";
import type { Frame, FrameError } from "../protocol/frames";
import { resolveAdapterInstallationId } from "../installation/admission";
import { managedInstallationWorkGate } from "../installation/lifecycle";
import { getKernelByInstallationId } from "../installation/routing";
import type { ServicePeerProfile } from "../kernel/peer";
import type { GatewayEnv } from "../runtime-env";

const ADAPTER_SERVICE_CALLS = [
  "adapter.inbound",
  "adapter.state.update",
] as const;
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

export class AdapterGatewayEntrypoint
  extends WorkerEntrypoint<GatewayEnv, ServicePeerProfile>
  implements GatewayAdapterInterface, ManagedAdapterGatewayService
{
  async serviceFrame(
    inputInstallation: AdapterInstallationContext,
    inputFrame: Frame,
  ): Promise<Frame | null> {
    try {
      const installation = adapterInstallationContextSchema.parse(inputInstallation);
      const frame = requireAdapterServiceFrame(inputFrame);
      return await routeAdapterServiceFrame(
        this.env,
        installation,
        this.resolveServicePeerProfile(),
        frame,
      );
    } catch (error) {
      await cancelBinaryBody(
        adapterServiceFrameBody(inputFrame),
        "Gateway service request failed",
      );
      console.error("[AdapterGatewayEntrypoint] serviceFrame failed:", error);
      return null;
    }
  }

  async linkedPeerFrame(
    inputInstallation: AdapterInstallationContext,
    inputContext: AdapterLinkedPeerContext,
    inputFrame: Frame,
  ): Promise<Frame | null> {
    let installation: AdapterInstallationContext;
    let context: AdapterLinkedPeerContext;
    let frame: Frame;
    try {
      installation = adapterInstallationContextSchema.parse(inputInstallation);
      context = adapterLinkedPeerContextSchema.parse(inputContext);
      frame = requireAdapterServiceFrame(inputFrame);
    } catch (error) {
      return await failLinkedPeerFrame(inputFrame, error, {
        code: 403,
        message: "Linked adapter request was rejected",
        retryable: false,
      });
    }
    try {
      return await routeAdapterLinkedPeerFrame(
        this.env,
        installation,
        this.resolveServicePeerProfile(),
        context,
        frame,
      );
    } catch (error) {
      // The Kernel answers its own refusals with error frames. A thrown failure
      // is transport or service trouble, so the adapter keeps the person's choice and retries.
      return await failLinkedPeerFrame(inputFrame, error, {
        code: 503,
        message: "Linked adapter request failed",
        retryable: true,
      });
    }
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

  async unlinkAdapterIdentity(
    installation: AdapterInstallationContext,
    input: UnlinkManagedAdapterIdentityInput,
  ): Promise<UnlinkManagedAdapterIdentityResult> {
    return await this.unlinkManagedAdapterIdentity(installation, input);
  }

  private resolveServicePeerProfile(): ServicePeerProfile {
    const parsed = adapterServicePeerProfileSchema.safeParse(this.ctx.props);
    if (!parsed.success || new Set(parsed.data.calls).size !== parsed.data.calls.length) {
      throw new Error("Adapter service binding props are invalid");
    }
    return parsed.data;
  }
}

async function routeAdapterServiceFrame(
  bindings: GatewayEnv,
  installation: AdapterInstallationContext,
  profile: ServicePeerProfile,
  frame: Frame,
): Promise<Frame | null> {
  const body = adapterServiceFrameBody(frame);
  try {
    const installationId = resolveAdapterInstallationId(bindings, installation);
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

async function routeAdapterLinkedPeerFrame(
  bindings: GatewayEnv,
  installation: AdapterInstallationContext,
  profile: ServicePeerProfile,
  context: AdapterLinkedPeerContext,
  frame: Frame,
): Promise<Frame | null> {
  const installationId = resolveAdapterInstallationId(bindings, installation);
  const gate = await managedInstallationWorkGate(bindings, installationId);
  if (!gate.allowed) {
    return frame.type === "req"
      ? {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: gate.code, message: gate.message },
        }
      : null;
  }
  const kernelStub: unknown = await getKernelByInstallationId(bindings.KERNEL, installationId);
  // SAFETY: this namespace is generated from Kernel; the narrow view avoids
  // recursively expanding every unrelated RPC method in Cloudflare's stub type.
  const kernel = kernelStub as {
    linkedAdapterPeerFrame(
      profile: ServicePeerProfile,
      context: AdapterLinkedPeerContext,
      frame: Frame,
    ): Promise<Frame | null>;
  };
  return await kernel.linkedAdapterPeerFrame(profile, context, frame);
}

async function failLinkedPeerFrame(
  inputFrame: Frame,
  cause: unknown,
  error: FrameError,
): Promise<Frame | null> {
  await cancelBinaryBody(adapterServiceFrameBody(inputFrame), error.message);
  console.error("[AdapterGatewayEntrypoint] linkedPeerFrame failed:", cause);
  const parsedCandidate = adapterGatewayFrameSchema.safeParse(inputFrame);
  return parsedCandidate.success && parsedCandidate.data.type === "req"
    ? { type: "res", id: parsedCandidate.data.id, ok: false, error }
    : null;
}

function requireAdapterServiceFrame(value: Frame): Frame {
  const parsed = adapterGatewayFrameSchema.safeParse(value);
  if (!parsed.success) throw new Error("Gateway serviceFrame frame is invalid");
  return value;
}

const adapterServiceFrameBodySchema = z.object({ body: binaryBodySchema });

function adapterServiceFrameBody(
  value: Frame,
): BinaryBody | undefined {
  const parsed = adapterServiceFrameBodySchema.safeParse(value);
  return parsed.success ? parsed.data.body : undefined;
}
