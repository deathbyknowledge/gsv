import { WorkerEntrypoint } from "cloudflare:workers";
import * as z from "zod/mini";
import type {
  AdapterInstallationContext,
  GatewayAdapterInterface,
} from "../adapter-interface";
import type {
  AdapterLinkedPeerContext,
  BinaryBody,
} from "@humansandmachines/gsv/protocol";
import type {
  AdapterGatewayService,
  UnlinkAdapterIdentityInput,
  UnlinkAdapterIdentityResult,
} from "@humansandmachines/gsv/services/adapters";
import {
  adapterGatewayFrameSchema,
  adapterInstallationContextSchema,
  adapterLinkedPeerContextSchema,
  binaryBodySchema,
  cancelBinaryBody,
} from "@humansandmachines/gsv/protocol";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { Frame, FrameError } from "../protocol/frames";
import { kernelForSettlement, kernelForWork, type WorkAdmission } from "../installation/admission";
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
  implements GatewayAdapterInterface, AdapterGatewayService
{
  async serviceFrame(
    inputInstallation: AdapterInstallationContext,
    inputFrame: Frame,
  ): Promise<Frame | null> {
    let installation: AdapterInstallationContext;
    let frame: Frame;
    try {
      installation = adapterInstallationContextSchema.parse(inputInstallation);
      frame = requireAdapterServiceFrame(inputFrame);
    } catch (error) {
      return await failAdapterFrame("serviceFrame", inputFrame, error, {
        code: 403,
        message: "Adapter service request was rejected",
        retryable: false,
      });
    }
    try {
      return await routeAdapterServiceFrame(
        this.env,
        installation,
        this.resolveServicePeerProfile(),
        frame,
      );
    } catch (error) {
      // The Kernel answers its own refusals with error frames. A thrown failure
      // is transport, service or binding trouble, so the adapter keeps the request and retries.
      return await failAdapterFrame("serviceFrame", inputFrame, error, {
        code: 503,
        message: "Adapter service request failed",
        retryable: true,
      });
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
      return await failAdapterFrame("linkedPeerFrame", inputFrame, error, {
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
      return await failAdapterFrame("linkedPeerFrame", inputFrame, error, {
        code: 503,
        message: "Linked adapter request failed",
        retryable: true,
      });
    }
  }

  async unlinkAdapterIdentity(
    installation: AdapterInstallationContext,
    input: UnlinkAdapterIdentityInput,
  ): Promise<UnlinkAdapterIdentityResult> {
    const kernel = await kernelForSettlement(this.env, installation);
    if (!kernel) return { removed: false };
    return await kernel.unlinkManagedAdapterIdentity(
      this.resolveServicePeerProfile().id,
      input,
    );
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
  const admission = await kernelForWork(bindings, installation);
  if (!admission.allowed) {
    await cancelBinaryBody(adapterServiceFrameBody(frame), admission.message);
    return refusalFrame(frame, admission);
  }
  const kernelStub: unknown = admission.kernel;
  // SAFETY: this namespace is generated from Kernel; the narrow view avoids
  // recursively expanding every unrelated RPC method in Cloudflare's stub type.
  const kernel = kernelStub as {
    peerFrame(profile: ServicePeerProfile, frame: Frame): Promise<Frame | null>;
  };
  return await kernel.peerFrame(profile, frame);
}

async function routeAdapterLinkedPeerFrame(
  bindings: GatewayEnv,
  installation: AdapterInstallationContext,
  profile: ServicePeerProfile,
  context: AdapterLinkedPeerContext,
  frame: Frame,
): Promise<Frame | null> {
  const admission = await kernelForWork(bindings, installation);
  if (!admission.allowed) return refusalFrame(frame, admission);
  const kernelStub: unknown = admission.kernel;
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

/** Answers a request Accounts did not admit with its reason; other frames get no answer. */
function refusalFrame(
  frame: Frame,
  refusal: Extract<WorkAdmission, { allowed: false }>,
): Frame | null {
  return frame.type === "req"
    ? { type: "res", id: frame.id, ok: false, error: { code: refusal.code, message: refusal.message } }
    : null;
}

/** Ends a frame the Gateway could not route: cancels its body, records why, and answers a request with `error`. */
async function failAdapterFrame(
  method: "serviceFrame" | "linkedPeerFrame",
  inputFrame: Frame,
  cause: unknown,
  error: FrameError,
): Promise<Frame | null> {
  await cancelBinaryBody(adapterServiceFrameBody(inputFrame), error.message);
  console.error(`[AdapterGatewayEntrypoint] ${method} failed:`, exceptionDiagnostics(cause));
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
