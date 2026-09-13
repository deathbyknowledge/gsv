import { describe, expect, it, vi } from "vitest";

import { AdapterGatewayEntrypoint, GatewayEntrypoint } from "./index";
import type { ServicePeerProfile } from "./kernel/peer";
import type { Frame } from "./protocol/frames";

type TrackedBodyFixture = {
  frame: Frame;
  cancelled(): string | undefined;
};

function requestFrame(id: string): Frame {
  return {
    type: "req",
    id,
    call: "adapter.inbound",
    args: { adapter: "telegram" },
  };
}

function requestFrameWithTrackedBody(id: string): TrackedBodyFixture {
  let cancelled: string | undefined;
  return {
    frame: {
      ...requestFrame(id),
      body: {
        stream: new ReadableStream<Uint8Array>({
          cancel(reason) {
            cancelled = reason instanceof Error ? reason.message : String(reason);
          },
        }),
      },
    },
    cancelled: () => cancelled,
  };
}

function gatewayWithEnv(
  value: Partial<Env>,
  props: ServicePeerProfile = {
    id: "telegram",
    calls: ["adapter.inbound", "adapter.state.update"],
  },
): AdapterGatewayEntrypoint {
  // SAFETY: The prototype instance exercises the entrypoint with injected test bindings.
  const gateway = Object.create(AdapterGatewayEntrypoint.prototype) as AdapterGatewayEntrypoint;
  Object.defineProperty(gateway, "env", { value });
  Object.defineProperty(gateway, "ctx", { value: { props } });
  return gateway;
}

describe("AdapterGatewayEntrypoint", () => {
  it.each(["unlinkManagedAdapterIdentity", "unlinkAdapterIdentity"] as const)("retains binding authority through %s", async (method) => {
    const unlinkManagedAdapterIdentity = vi.fn(async () => ({ removed: true }));
    const getByName = vi.fn(() => ({ unlinkManagedAdapterIdentity }));
    const resolveInstallation = vi.fn(async () => ({ found: true, installationId: "inst_alias", state: "retained" }));
    const gateway = gatewayWithEnv({ KERNEL: { getByName }, INSTALLATION_DIRECTORY: { resolveInstallation } });
    const request = { operationId: "operation-alias", accountId: "managed", actorId: "actor", surfaceId: "surface",
      expectedLocalUid: 1000, expectedGeneration: "old-generation" };
    expect(await gateway[method]({ installationId: "inst_alias" }, request)).toEqual({ removed: true });
    expect(getByName).toHaveBeenCalledWith("inst_alias");
    expect(unlinkManagedAdapterIdentity).toHaveBeenCalledWith("telegram", request);
    expect("unlinkAdapterIdentity" in GatewayEntrypoint.prototype).toBe(false);
  });

  it("keeps adapter RPC off the generic Gateway entrypoint", () => {
    const gateway = gatewayWithEnv({});

    expect("serviceFrame" in gateway).toBe(true);
    expect("linkedPeerFrame" in gateway).toBe(true);
    expect("acceptManagedInboundMail" in gateway).toBe(false);
    expect("serviceFrame" in GatewayEntrypoint.prototype).toBe(false);
  });

  it("routes directory-admitted calls with binding authority", async () => {
    const response = {
      type: "res" as const,
      id: "scoped",
      ok: true,
      data: { routed: true },
    };
    const peerFrame = vi.fn(async () => response);
    const getByName = vi.fn(() => ({ peerFrame }));
    const gateway = gatewayWithEnv(
      { KERNEL: { getByName }, INSTALLATION_DIRECTORY: activeDirectory() },
      { id: "discord", calls: ["adapter.inbound"] },
    );
    const frame = requestFrame("scoped");

    await expect(gateway.serviceFrame(
      { installationId: "inst_adapter_fixture" },
      frame,
    )).resolves.toEqual(response);
    expect(getByName).toHaveBeenCalledWith("inst_adapter_fixture");
    expect(peerFrame).toHaveBeenCalledWith(
      { id: "discord", calls: ["adapter.inbound"] },
      frame,
    );
  });

  it("routes linked-human calls with directory-admitted context", async () => {
    const response = {
      type: "res" as const,
      id: "linked-approval",
      ok: true,
      data: { ok: true, resumed: true },
    };
    const linkedAdapterPeerFrame = vi.fn(async () => response);
    const getByName = vi.fn(() => ({ linkedAdapterPeerFrame }));
    const gateway = gatewayWithEnv({ KERNEL: { getByName }, INSTALLATION_DIRECTORY: activeDirectory() });
    const context = {
      accountId: "default",
      actorId: "telegram:user:42",
      surface: { kind: "dm" as const, id: "chat-42" },
      interactionId: "callback-1",
    };
    const frame: Frame = {
      type: "req",
      id: "linked-approval",
      call: "proc.hil",
      args: { pid: "proc-1", requestId: "request-1", decision: "approve" },
    };

    await expect(gateway.linkedPeerFrame(
      { installationId: "inst_adapter_fixture" },
      context,
      frame,
    )).resolves.toEqual(response);
    expect(getByName).toHaveBeenCalledWith("inst_adapter_fixture");
    expect(linkedAdapterPeerFrame).toHaveBeenCalledWith(
      { id: "telegram", calls: ["adapter.inbound", "adapter.state.update"] },
      context,
      frame,
    );
  });

  it("gates managed calls by their explicit installation", async () => {
    const installation = { installationId: "inst_adapter_gateway" };
    const response = {
      type: "res" as const,
      id: "managed",
      ok: true,
      data: { routed: true },
    };
    const peerFrame = vi.fn(async () => response);
    const getByName = vi.fn(() => ({ peerFrame }));
    const resolveInstallation = vi.fn(async () => ({
      found: true as const,
      installationId: installation.installationId,
      handle: "adapter-gateway",
      canonicalOrigin: "https://adapter-gateway.gsv.space",
      state: "active" as const,
    }));
    const gateway = gatewayWithEnv({
      INSTALLATION_DIRECTORY: { resolveInstallation },
      KERNEL: { getByName },
    });
    const frame = requestFrame("managed");

    await expect(gateway.serviceFrame(installation, frame)).resolves.toEqual(response);
    expect(resolveInstallation).toHaveBeenCalledWith(installation.installationId);
    expect(getByName).toHaveBeenCalledWith(installation.installationId);
    expect(peerFrame).toHaveBeenCalledWith(
      { id: "telegram", calls: ["adapter.inbound", "adapter.state.update"] },
      frame,
    );
  });

  it("rejects unavailable or missing directories before selecting a Kernel and cancels bodies", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const getByName = vi.fn();
    const unavailable = requestFrameWithTrackedBody("unavailable-directory");
    const gateway = gatewayWithEnv({
      INSTALLATION_DIRECTORY: { resolveInstallation: vi.fn(async () => ({ found: false })) },
      KERNEL: { getByName },
    });
    await expect(gateway.serviceFrame({ installationId: "inst_missing" }, unavailable.frame))
      .resolves.toMatchObject({ ok: false, error: { code: 503 } });
    expect(unavailable.cancelled()).toBe("Managed installation is unavailable");
    const missing = requestFrameWithTrackedBody("missing-directory");
    await expect(gatewayWithEnv({ KERNEL: { getByName } }).serviceFrame(
      { installationId: "inst_missing" }, missing.frame,
    )).resolves.toBeNull();
    expect(missing.cancelled()).toBe("Gateway service request failed");
    expect(getByName).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("rejects invalid binding props before entering the Kernel", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = requestFrameWithTrackedBody("invalid-binding-props");
    const getByName = vi.fn();
    const gateway = gatewayWithEnv(
      { KERNEL: { getByName } },
      { id: "telegram", calls: ["adapter.inbound", "account.list"] },
    );

    await expect(gateway.serviceFrame(
      { installationId: "inst_adapter_fixture" },
      request.frame,
    )).resolves.toBeNull();
    expect(request.cancelled()).toBe("Gateway service request failed");
    expect(getByName).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

function activeDirectory() {
  return {
    resolveInstallation: vi.fn(async (installationId: string) => ({
      found: true as const, installationId, state: "active" as const,
      handle: "fixture", canonicalOrigin: "https://fixture.invalid",
    })),
  };
}
