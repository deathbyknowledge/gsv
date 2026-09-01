import type {
  AdapterServiceDescriptor,
  AdapterTargetIdentity,
  AdapterTargetRequestFrame,
  AdapterTargetResponseFrame,
} from "@humansandmachines/gsv/services/adapters";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import {
  adapterTargetCancelResultSchema,
  adapterTargetDescriptorListSchema,
  adapterTargetResponseFrameSchema,
  adapterServiceDescriptorSchema,
} from "@humansandmachines/gsv/services/adapters";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { stableOpaqueId } from "../shared/stable-id";
import { withByteStreamFinalizer } from "../shared/streams";
import { resolveAdapterService } from "./adapter-handlers";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { IdentityLinkRecord } from "./identity-links";
import type { TargetDescriptor, TargetListOptions } from "./targets";
import { z } from "zod";

const adapterTargetLinkMetadataSchema = z.object({
  routeGeneration: z.string().optional(),
}).passthrough();

const ADAPTER_TARGET_DISCOVERY_TIMEOUT_MS = 1_000;

export type AdapterTargetRoute = {
  kind: "adapter";
  adapter: string;
  accountId: string;
  actorId: string;
  routeGeneration?: string;
  adapterTargetId: string;
};

export async function listVisibleAdapterTargets(
  ctx: KernelContext,
  options: TargetListOptions = {},
): Promise<TargetDescriptor[]> {
  if (!ctx.identity || ctx.identity.role !== "user") return [];

  const ownerUid = resolveCallerOwnerUid(ctx);
  const links = ctx.adapters.identityLinks.list(ownerUid);
  const groups = new Map<string, IdentityLinkRecord>();
  const targetSupport = new Map<string, Promise<boolean>>();
  for (const link of links) {
    groups.set(`${link.adapter}\0${link.accountId}\0${link.actorId}`, link);
  }

  const targets = await Promise.all([...groups.values()].map(async (link) => {
    const adapter = link.adapter.trim().toLowerCase();
    const accountId = link.accountId.trim();
    const actorId = link.actorId.trim();
    const service = resolveAdapterService(ctx.env, adapter);
    if (
      !adapter
      || !accountId
      || !actorId
      || !service?.adapterTargetList
      || !service.adapterTargetExecute
      || !service.adapterTargetCancel
    ) {
      return [];
    }

    let supported = targetSupport.get(adapter);
    if (!supported) {
      supported = adapterSupportsTargets(adapter, service, ctx);
      targetSupport.set(adapter, supported);
    }
    if (!await supported) return [];

    const status = ctx.adapters.status.get(adapter, accountId);
    const online = status?.connected === true && status.authenticated === true;
    if (!options.includeOffline && !online) return [];

    const identity = adapterTargetIdentity(link);
    try {
      const acquisition = service.adapterTargetList(
        { installationId: ctx.installationId },
        identity,
      );
      const acquired = await waitForAdapterDiscovery(acquisition, ctx);
      if (!acquired) return [];
      using descriptors = acquired;
      const decoded = adapterTargetDescriptorListSchema.safeParse(
        descriptors,
      );
      if (!decoded.success) return [];

      const seen = new Set<string>();
      const projected: TargetDescriptor[] = [];
      for (const descriptor of decoded.data) {
        if (seen.has(descriptor.id)) continue;
        seen.add(descriptor.id);
        const targetId = await stableOpaqueId(`${adapter}-target`, [
          ctx.installationId,
          accountId,
          actorId,
          descriptor.id,
        ]);
        projected.push({
          targetId,
          ownerUid: link.uid,
          ownerUsername: ctx.auth.getPasswdByUid(link.uid)?.username ?? null,
          label: descriptor.label,
          description: descriptor.description,
          platform: descriptor.platform,
          version: descriptor.version,
          online,
          implements: descriptor.implements,
          firstSeenAt: link.createdAt,
          lastSeenAt: status?.updatedAt ?? link.createdAt,
          connectedAt: online ? status?.updatedAt ?? link.createdAt : null,
          disconnectedAt: online ? null : status?.updatedAt ?? null,
          route: {
            kind: "adapter",
            adapter,
            accountId,
            actorId,
            routeGeneration: identity.routeGeneration,
            adapterTargetId: descriptor.id,
          },
        });
      }
      return projected;
    } catch {
      return [];
    }
  }));

  return targets.flat();
}

async function adapterSupportsTargets(
  adapter: string,
  service: NonNullable<ReturnType<typeof resolveAdapterService>>,
  ctx: KernelContext,
): Promise<boolean> {
  try {
    if (!service.adapterDescribe) return false;
    // SAFETY: object-valued Workers RPC results carry a disposer that owns the
    // remote result for the lifetime of this acquisition.
    const acquisition = service.adapterDescribe() as Promise<
      AdapterServiceDescriptor & Disposable
    >;
    const acquired = await waitForAdapterDiscovery(acquisition, ctx);
    if (!acquired) return false;
    using descriptorResult = acquired;
    const descriptor = adapterServiceDescriptorSchema.safeParse(descriptorResult);
    return descriptor.success
      && descriptor.data.id === adapter
      && descriptor.data.capabilities.targets === true;
  } catch {
    return false;
  }
}

export async function requestAdapterTarget(
  frame: RequestFrame,
  target: TargetDescriptor,
  deadlineAt: number,
  ctx: KernelContext,
): Promise<ResponseFrame> {
  const route = target.route;
  if (route.kind !== "adapter") {
    return errorFrame(frame.id, 500, "Target provider route is invalid");
  }
  const service = resolveAdapterService(ctx.env, route.adapter);
  if (!service?.adapterTargetExecute || !service.adapterTargetCancel) {
    return errorFrame(frame.id, 503, `Target provider unavailable: ${target.targetId}`);
  }

  const identity: AdapterTargetIdentity = {
    accountId: route.accountId,
    actorId: route.actorId,
  };
  if (route.routeGeneration) identity.routeGeneration = route.routeGeneration;
  // SAFETY: RequestFrame is the same syscall-discriminated envelope; this
  // boundary adds only the adapter-owned absolute deadline.
  const request = {
    ...frame,
    deadlineAt,
  } as AdapterTargetRequestFrame;
  const invocation = service.adapterTargetExecute(
    { installationId: ctx.installationId },
    identity,
    route.adapterTargetId,
    request,
  );

  try {
    const outcome = await waitForAdapterTarget(invocation, async () => {
      using cancellation = await service.adapterTargetCancel!(
        { installationId: ctx.installationId },
        identity,
        route.adapterTargetId,
        frame.id,
      );
      const result = adapterTargetCancelResultSchema.safeParse(
        cancellation,
      );
      if (!result.success) throw new Error("Adapter returned an invalid cancellation response");
    }, deadlineAt, ctx);
    if (outcome.kind === "cancelled") {
      return errorFrame(frame.id, 499, requestCancelMessage(ctx.requestSignal));
    }
    if (outcome.kind === "timed_out") {
      return errorFrame(
        frame.id,
        504,
        `Syscall ${frame.call} timed out (target: ${target.targetId})`,
      );
    }
    const response = outcome.response;
    const decoded = adapterTargetResponseFrameSchema.safeParse(response);
    if (!decoded.success || decoded.data.id !== frame.id) {
      response[Symbol.dispose]();
      return errorFrame(frame.id, 502, `Target provider returned an invalid response: ${target.targetId}`);
    }
    if (!decoded.data.ok || decoded.data.body === undefined) {
      response[Symbol.dispose]();
      // SAFETY: the public adapter-target schema validates the same response
      // envelope consumed by Kernel syscall dispatch.
      return decoded.data as ResponseFrame;
    }
    const body = decoded.data.body;
    try {
      // SAFETY: the response schema validated every envelope field and the
      // replacement stream preserves the validated binary-body contract.
      const transferred: ResponseFrame = {
        ...decoded.data,
        body: {
          ...body,
          stream: withByteStreamFinalizer(body.stream, () => {
            try {
              response[Symbol.dispose]();
            } catch {
              // The body reached its terminal outcome; no further RPC work remains.
            }
          }),
        },
      } as ResponseFrame;
      return transferred;
    } catch {
      await cancelBinaryBody(body, "Adapter target response body could not be transferred");
      response[Symbol.dispose]();
      return errorFrame(frame.id, 502, `Target provider returned an invalid body: ${target.targetId}`);
    }
  } catch {
    if (ctx.requestSignal?.aborted) {
      return errorFrame(frame.id, 499, requestCancelMessage(ctx.requestSignal));
    }
    return errorFrame(frame.id, 502, `Target provider request failed: ${target.targetId}`);
  }
}

type AdapterDiscoveryOutcome<T> =
  | { kind: "result"; value: T }
  | { kind: "failed" }
  | { kind: "timed_out" };

async function waitForAdapterDiscovery<T extends Disposable>(
  acquisition: Promise<T>,
  ctx: KernelContext,
): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled: Promise<AdapterDiscoveryOutcome<T>> = acquisition.then(
    (value): AdapterDiscoveryOutcome<T> => ({ kind: "result", value }),
    (): AdapterDiscoveryOutcome<T> => ({ kind: "failed" }),
  );
  const timedOut = new Promise<AdapterDiscoveryOutcome<T>>((resolve) => {
    timeout = setTimeout(
      () => resolve({ kind: "timed_out" }),
      ADAPTER_TARGET_DISCOVERY_TIMEOUT_MS,
    );
  });
  const outcome = await Promise.race([settled, timedOut]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome.kind === "result") return outcome.value;
  if (outcome.kind === "timed_out") {
    if (!disposeAdapterDiscoveryAcquisition(acquisition)) {
      ctx.defer(settled.then((late) => {
        if (late.kind === "result") late.value[Symbol.dispose]();
      }));
    }
  }
  return null;
}

function disposeAdapterDiscoveryAcquisition<T>(acquisition: Promise<T>): boolean {
  // SAFETY: Workers RPC promises implement Symbol.dispose. Disposing the
  // acquisition also disposes an object-valued result that arrives later.
  const disposable = acquisition as Promise<T> & Partial<Disposable>;
  const dispose = disposable[Symbol.dispose];
  if (!dispose) return false;
  dispose.call(disposable);
  return true;
}

function adapterTargetIdentity(link: IdentityLinkRecord): AdapterTargetIdentity {
  const identity: AdapterTargetIdentity = {
    accountId: link.accountId.trim(),
    actorId: link.actorId.trim(),
  };
  const metadata = adapterTargetLinkMetadataSchema.safeParse(link.metadata);
  const routeGeneration = metadata.success
    ? metadata.data.routeGeneration?.trim()
    : undefined;
  if (routeGeneration) {
    identity.routeGeneration = routeGeneration;
  }
  return identity;
}

type AdapterTargetWaitResult =
  | { kind: "response"; response: AdapterTargetResponseFrame & Disposable }
  | { kind: "cancelled" }
  | { kind: "timed_out" };

async function waitForAdapterTarget(
  invocation: Promise<AdapterTargetResponseFrame & Disposable>,
  cancel: () => Promise<void>,
  deadlineAt: number,
  ctx: KernelContext,
): Promise<AdapterTargetWaitResult> {
  const signal = ctx.requestSignal;
  return await new Promise<AdapterTargetWaitResult>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanUp = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const abandon = (kind: "cancelled" | "timed_out"): void => {
      if (settled) return;
      settled = true;
      cleanUp();
      ctx.defer(cancel().catch(() => undefined));
      discardLateAdapterResponse(invocation);
      resolve({ kind });
    };
    const onAbort = (): void => {
      abandon("cancelled");
    };

    if (signal?.aborted) {
      abandon("cancelled");
      return;
    }
    const remainingMs = Math.max(0, Math.trunc(deadlineAt - Date.now()));
    timeout = setTimeout(() => abandon("timed_out"), remainingMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void invocation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanUp();
        resolve({ kind: "response", response: value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanUp();
        reject(error);
      },
    );
  });
}

function discardLateAdapterResponse(
  invocation: Promise<AdapterTargetResponseFrame & Disposable>,
): void {
  void invocation.then(async (response) => {
    try {
      const decoded = adapterTargetResponseFrameSchema.safeParse(response);
      if (decoded.success && decoded.data.ok) {
        await cancelBinaryBody(decoded.data.body, "Adapter target response arrived after cancellation");
      }
    } finally {
      response[Symbol.dispose]();
    }
  }).catch(() => undefined);
}

function errorFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function requestCancelMessage(signal: AbortSignal | undefined): string {
  return signal?.reason instanceof Error ? signal.reason.message : "Request cancelled";
}
