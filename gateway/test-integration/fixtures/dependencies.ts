import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
} from "@humansandmachines/gsv/protocol";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterGatewayInterface,
  AdapterGatewayRequestFrame,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSurface,
  AdapterWorkerInterface,
  AuthorizeInstallationOnboardingInput,
  BinaryBody,
  CompleteInstallationOnboardingInput,
  CompleteInstallationOnboardingResult,
  InstallationDirectoryResult,
  InstallationOnboardingAuthorization,
  ManagedInstallationState,
  ManagedInferenceAbortRequest,
  ManagedInferenceRequest,
  ManagedInferenceResult,
  ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import { SINGLETON_INSTALLATION_ID } from "../../src/installation/identity";
import {
  resolveAdapterActivityRpcArgs,
  resolveAdapterConnectRpcArgs,
  resolveAdapterDisconnectRpcArgs,
  resolveAdapterSendRpcArgs,
  resolveAdapterStatusRpcArgs,
  type AdapterActivityRpcArgs,
  type AdapterConnectRpcArgs,
  type AdapterDisconnectRpcArgs,
  type AdapterSendRpcArgs,
  type AdapterStatusRpcArgs,
} from "../../../adapters/shared/src/rpc-compat";

type ImportRequest = {
  remoteUrl?: unknown;
  remoteRef?: unknown;
};

export type RecordedOutboundMessage = {
  installationId: string;
  accountId: string;
  message: AdapterOutboundMessage;
};

type OnboardingCompletionFailure = "before-activation" | "after-activation";

interface Env {
  GATEWAY: Fetcher & AdapterGatewayInterface;
  INTEGRATION_STATE: DurableObjectNamespace<IntegrationState>;
}

export class IntegrationState extends DurableObject<Env> {
  async recordOutbound(entry: RecordedOutboundMessage): Promise<void> {
    const messages = await this.ctx.storage.get<RecordedOutboundMessage[]>("outbound") ?? [];
    messages.push(entry);
    await this.ctx.storage.put("outbound", messages);
  }

  async listOutbound(
    installationId?: string,
    accountId?: string,
  ): Promise<RecordedOutboundMessage[]> {
    const messages = await this.ctx.storage.get<RecordedOutboundMessage[]>("outbound") ?? [];
    return messages.filter((entry) => (
      (!installationId || entry.installationId === installationId)
      && (!accountId || entry.accountId === accountId)
    ));
  }

  async setInstallationState(
    handle: string,
    state: ManagedInstallationState,
  ): Promise<void> {
    await this.ctx.storage.put(`installation:${handle}:state`, state);
  }

  async getInstallationState(handle: string): Promise<ManagedInstallationState> {
    return await this.ctx.storage.get<ManagedInstallationState>(
      `installation:${handle}:state`,
    ) ?? "active";
  }

  async setOnboardingCompletionFailure(
    handle: string,
    failure: OnboardingCompletionFailure,
  ): Promise<void> {
    await this.ctx.storage.put(`installation:${handle}:completion-failure`, failure);
  }

  async takeOnboardingCompletionFailure(
    handle: string,
  ): Promise<OnboardingCompletionFailure | null> {
    const key = `installation:${handle}:completion-failure`;
    const failure = await this.ctx.storage.get<OnboardingCompletionFailure>(key) ?? null;
    if (failure) await this.ctx.storage.delete(key);
    return failure;
  }

  async recordManagedInferenceCancellation(installationId: string): Promise<void> {
    await this.ctx.storage.put(`managed-inference-cancelled:${installationId}`, true);
  }

  async wasManagedInferenceCancelled(installationId: string): Promise<boolean> {
    return await this.ctx.storage.get<boolean>(
      `managed-inference-cancelled:${installationId}`,
    ) === true;
  }
}

export class ManagedInferenceFixture
  extends WorkerEntrypoint<Env>
  implements ManagedInferenceService
{
  async generate(input: ManagedInferenceRequest): Promise<ManagedInferenceResult> {
    const waitsForCancellation = input.messages.some((message) => (
      message.role === "user" && message.content === "wait for cancellation"
    ));
    if (waitsForCancellation) {
      const id = this.env.INTEGRATION_STATE.idFromName(SINGLETON_INSTALLATION_ID);
      const state = this.env.INTEGRATION_STATE.get(id);
      while (!await state.wasManagedInferenceCancelled(input.installationId)) {
        await scheduler.wait(10);
      }
    }

    const text = [
      `managed:${input.installationId}`,
      `uid:${input.actor.localUid}`,
      `pid:${input.actor.processId ?? "none"}`,
      `run:${input.actor.runId ?? "none"}`,
    ].join(":");
    const result: ManagedInferenceResult = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "gsv-inference",
      provider: GSV_INFERENCE_PROVIDER,
      model: GSV_INFERENCE_PRODUCT_MODEL,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    return result;
  }

  async abort(input: ManagedInferenceAbortRequest): Promise<void> {
    const id = this.env.INTEGRATION_STATE.idFromName(SINGLETON_INSTALLATION_ID);
    await this.env.INTEGRATION_STATE.get(id).recordManagedInferenceCancellation(
      input.installationId,
    );
  }
}

export default class TestDependencies
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "test";

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    const handle = hostname.endsWith(".gsv.space")
      ? hostname.slice(0, -".gsv.space".length)
      : "";
    if (handle !== "first" && handle !== "second" && handle !== "suspended") {
      return { found: false };
    }
    return {
      found: true,
      installationId: `inst_integration_${handle}`,
      handle,
      canonicalOrigin: `https://${handle}.gsv.space`,
      state: handle === "suspended"
        ? "deleted"
        : await this.integrationState().getInstallationState(handle),
    };
  }

  async resolveInstallation(
    installationId: string,
  ): Promise<InstallationDirectoryResult> {
    const handle = installationHandle(installationId);
    return handle
      ? await this.resolveHostname(`${handle}.gsv.space`)
      : { found: false };
  }

  async authorizeInstallationOnboarding(
    input: AuthorizeInstallationOnboardingInput,
  ): Promise<InstallationOnboardingAuthorization> {
    const handle = installationHandle(input.installationId);
    if (
      !handle
      || input.token !== `integration-onboarding-${handle}`
      || await this.integrationState().getInstallationState(handle) !== "provisioning"
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      claimId: `integration-claim-${handle}`,
      installation: installationIdentity(handle),
    };
  }

  async completeInstallationOnboarding(
    input: CompleteInstallationOnboardingInput,
  ): Promise<CompleteInstallationOnboardingResult> {
    const handle = installationHandle(input.installationId);
    if (
      !handle
      || input.claimId !== `integration-claim-${handle}`
      || await this.integrationState().getInstallationState(handle) !== "provisioning"
    ) {
      throw new Error("integration onboarding claim is invalid");
    }
    const failure = await this.integrationState().takeOnboardingCompletionFailure(handle);
    if (failure === "before-activation") {
      throw new Error("integration onboarding completion failed before activation");
    }
    await this.integrationState().setInstallationState(handle, "active");
    if (failure === "after-activation") {
      throw new Error("integration onboarding completion failed after activation");
    }
    return { state: "complete", installationId: input.installationId };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__test/service-frame" && request.method === "POST") {
      const input = await request.json<{
        installation: AdapterInstallationContext;
        frame: AdapterGatewayRequestFrame;
      }>();
      const response = await this.env.GATEWAY.serviceFrame(
        input.installation,
        input.frame,
      );
      return Response.json(response);
    }

    if (url.pathname === "/__test/outbound" && request.method === "GET") {
      const installationId = url.searchParams.get("installationId") ?? undefined;
      const accountId = url.searchParams.get("accountId") ?? undefined;
      return Response.json(await this.integrationState().listOutbound(
        installationId,
        accountId,
      ));
    }

    if (url.pathname === "/__test/provisioning" && request.method === "POST") {
      const handle = url.searchParams.get("handle") ?? "";
      if (handle !== "first" && handle !== "second") {
        return new Response("invalid handle", { status: 400 });
      }
      await this.integrationState().setInstallationState(handle, "provisioning");
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/__test/installation-state" && request.method === "POST") {
      const handle = url.searchParams.get("handle") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (
        (handle !== "first" && handle !== "second")
        || (state !== "active" && state !== "restricted")
      ) {
        return new Response("invalid installation state", { status: 400 });
      }
      await this.integrationState().setInstallationState(handle, state);
      return new Response(null, { status: 204 });
    }

    if (
      url.pathname === "/__test/onboarding-completion-failure"
      && request.method === "POST"
    ) {
      const handle = url.searchParams.get("handle") ?? "";
      const failure = url.searchParams.get("failure") ?? "";
      if (
        (handle !== "first" && handle !== "second")
        || (failure !== "before-activation" && failure !== "after-activation")
      ) {
        return new Response("invalid onboarding completion failure", { status: 400 });
      }
      await this.integrationState().setOnboardingCompletionFailure(handle, failure);
      return new Response(null, { status: 204 });
    }

    if (url.pathname.endsWith("/read") && request.method === "GET") {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname.endsWith("/apply") && request.method === "POST") {
      const input = await request.json<Record<string, unknown>>();
      if (!Array.isArray(input.ops)) {
        return Response.json({ ok: false, error: "ops are required" }, { status: 400 });
      }
      return Response.json({ ok: true, head: "integration-head" });
    }

    if (url.pathname.endsWith("/import") && request.method === "POST") {
      const input = await request.json<ImportRequest>();
      return Response.json({
        ok: true,
        head: "integration-head",
        changed: true,
        remote_url: typeof input.remoteUrl === "string"
          ? input.remoteUrl
          : "https://example.invalid/gsv-manual",
        remote_ref: typeof input.remoteRef === "string" ? input.remoteRef : "main",
      });
    }

    await request.body?.cancel("Unhandled test dependency request").catch(() => {});
    return new Response(`Unhandled test dependency request: ${request.method} ${url.pathname}`, {
      status: 501,
    });
  }

  async adapterConnect(
    accountId: string,
    config?: Record<string, unknown>,
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }>;
  async adapterConnect(
    installation: AdapterInstallationContext,
    accountId: string,
    config?: Record<string, unknown>,
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }>;
  async adapterConnect(
    ...args: AdapterConnectRpcArgs
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }> {
    const resolved = resolveAdapterConnectRpcArgs(args);
    return await this.#adapterConnectForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.config,
    );
  }

  async #adapterConnectForInstallation(
    _installation: AdapterInstallationContext,
    _accountId: string,
    _config?: Record<string, unknown>,
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }> {
    return {
      ok: true,
      connected: true,
      authenticated: true,
      message: "connected by integration fixture",
    };
  }

  async adapterDisconnect(
    accountId: string,
  ): Promise<{ ok: true; message: string }>;
  async adapterDisconnect(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<{ ok: true; message: string }>;
  async adapterDisconnect(
    ...args: AdapterDisconnectRpcArgs
  ): Promise<{ ok: true; message: string }> {
    const resolved = resolveAdapterDisconnectRpcArgs(args);
    return await this.#adapterDisconnectForInstallation(
      resolved.installation,
      resolved.accountId,
    );
  }

  async #adapterDisconnectForInstallation(
    _installation: AdapterInstallationContext,
    _accountId: string,
  ): Promise<{ ok: true; message: string }> {
    return { ok: true, message: "disconnected by integration fixture" };
  }

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<{ ok: true; messageId: string }>;
  async adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<{ ok: true; messageId: string }>;
  async adapterSend(
    ...args: AdapterSendRpcArgs
  ): Promise<{ ok: true; messageId: string }> {
    const resolved = await resolveAdapterSendRpcArgs(args);
    return await this.#adapterSendForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.message,
      resolved.body,
    );
  }

  async #adapterSendForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<{ ok: true; messageId: string }> {
    if (body && !body.stream.locked) {
      await body.stream.cancel("Integration fixture does not consume media").catch(() => {});
    }
    await this.integrationState().recordOutbound({
      installationId: installation.installationId,
      accountId,
      message,
    });
    return { ok: true, messageId: `fixture:${message.deliveryId}` };
  }

  async adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true }>;
  async adapterSetActivity(
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true }>;
  async adapterSetActivity(
    ...args: AdapterActivityRpcArgs
  ): Promise<{ ok: true }> {
    const resolved = resolveAdapterActivityRpcArgs(args);
    return await this.#adapterSetActivityForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.surface,
      resolved.activity,
    );
  }

  async #adapterSetActivityForInstallation(
    _installation: AdapterInstallationContext,
    _accountId: string,
    _surface: AdapterSurface,
    _activity: AdapterActivity,
  ): Promise<{ ok: true }> {
    return { ok: true };
  }

  async adapterStatus(
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  async adapterStatus(...args: AdapterStatusRpcArgs): Promise<AdapterAccountStatus[]> {
    const resolved = resolveAdapterStatusRpcArgs(args);
    return await this.#adapterStatusForInstallation(
      resolved.installation,
      resolved.accountId,
    );
  }

  async #adapterStatusForInstallation(
    _installation: AdapterInstallationContext,
    _accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    return [];
  }

  async run(
    _model: string,
    _input: unknown,
    _options?: Record<string, unknown>,
  ): Promise<Record<string, never>> {
    return {};
  }

  async models(): Promise<never[]> {
    return [];
  }

  private integrationState(): DurableObjectStub<IntegrationState> {
    const id = this.env.INTEGRATION_STATE.idFromName(SINGLETON_INSTALLATION_ID);
    return this.env.INTEGRATION_STATE.get(id);
  }
}

function installationHandle(installationId: string): "first" | "second" | null {
  if (installationId === "inst_integration_first") return "first";
  if (installationId === "inst_integration_second") return "second";
  return null;
}

function installationIdentity(handle: "first" | "second") {
  return {
    installationId: `inst_integration_${handle}`,
    handle,
    canonicalOrigin: `https://${handle}.gsv.space`,
  };
}
