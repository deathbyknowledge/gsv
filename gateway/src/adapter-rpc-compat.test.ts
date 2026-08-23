import { describe, expect, it, vi } from "vitest";

import { GatewayEntrypoint, TelegramGatewayEntrypoint } from "./index";
import type { Frame } from "./protocol/frames";

type TrackedBody = { stream: ReadableStream<Uint8Array> };
type TrackedBodyFixture = { frame: Frame; body: TrackedBody; cancelled: () => string | undefined };
type GatewayTestEnv = Partial<Env>;
type ServiceFrameArguments = (...values: unknown[]) => Promise<Frame | null>;

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
  const body = {
    stream: new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason instanceof Error ? reason.message : String(reason);
      },
    }),
  };
  return {
    frame: { ...requestFrame(id), body },
    body,
    cancelled: () => cancelled,
  };
}

function telegramGatewayWithEnv(value: GatewayTestEnv): TelegramGatewayEntrypoint {
  // SAFETY: The prototype instance is used to exercise the entrypoint with an injected test environment.
  const gateway = Object.create(TelegramGatewayEntrypoint.prototype) as TelegramGatewayEntrypoint;
  Object.defineProperty(gateway, "env", { value });
  Object.defineProperty(gateway, "servicePeerProfile", {
    value: { id: "telegram", calls: ["adapter.inbound", "adapter.state.update"] },
  });
  return gateway;
}

function genericGatewayWithEnv(value: GatewayTestEnv): GatewayEntrypoint {
  // SAFETY: The prototype instance is used to exercise the entrypoint with an injected test environment.
  const gateway = Object.create(GatewayEntrypoint.prototype) as GatewayEntrypoint;
  Object.defineProperty(gateway, "env", { value });
  return gateway;
}

async function callServiceFrame(
  gateway: GatewayEntrypoint,
  ...args: unknown[]
): Promise<Frame | null> {
  // SAFETY: The compatibility test deliberately invokes the overloaded method with malformed argument lists.
  const serviceFrame = gateway.serviceFrame as ServiceFrameArguments;
  return await serviceFrame.apply(gateway, args);
}

describe("Gateway adapter RPC compatibility", () => {
  it("accepts the pre-managed one-argument serviceFrame call", async () => {
    const response = {
      type: "res" as const,
      id: "legacy",
      ok: true,
      data: { routed: true },
    };
    const peerFrame = vi.fn(async () => response);
    const getByName = vi.fn(() => ({ peerFrame }));
    const gateway = telegramGatewayWithEnv({ KERNEL: { getByName } });
    const frame = requestFrame("legacy");

    await expect(gateway.serviceFrame(frame)).resolves.toEqual(response);
    expect(getByName).toHaveBeenCalledWith("singleton");
    expect(peerFrame).toHaveBeenCalledWith(
      { id: "telegram", calls: ["adapter.inbound", "adapter.state.update"] },
      frame,
    );
  });

  it("accepts the already-deployed managed two-argument serviceFrame call", async () => {
    const installation = { installationId: "inst_rpc_compat" };
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
      handle: "rpc-compat",
      canonicalOrigin: "https://rpc-compat.gsv.space",
      state: "active" as const,
    }));
    const gateway = telegramGatewayWithEnv({
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

  it("fails closed across deployment modes and cancels untransferred bodies", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const managedRequest = requestFrameWithTrackedBody("managed-legacy-call");
    const managedGateway = telegramGatewayWithEnv({
      INSTALLATION_DIRECTORY: {},
      KERNEL: {},
    });

    await expect(managedGateway.serviceFrame(managedRequest.frame)).resolves.toBeNull();
    expect(managedRequest.cancelled()).toBe("Gateway service request failed");

    const getByName = vi.fn();
    const standaloneRequest = requestFrameWithTrackedBody("standalone-scoped-call");
    const standaloneGateway = telegramGatewayWithEnv({ KERNEL: { getByName } });

    await expect(standaloneGateway.serviceFrame(
      { installationId: "inst_rpc_compat" },
      standaloneRequest.frame,
    )).resolves.toBeNull();
    expect(standaloneRequest.cancelled()).toBe("Gateway service request failed");
    expect(getByName).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("rejects malformed RPC variants and cancels every candidate frame body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const getByName = vi.fn();
    const gateway = telegramGatewayWithEnv({ KERNEL: { getByName } });

    await expect(callServiceFrame(gateway, null)).resolves.toBeNull();

    const malformedFrame = requestFrameWithTrackedBody("malformed-frame");
    await expect(callServiceFrame(gateway, {
      body: malformedFrame.body,
    })).resolves.toBeNull();
    expect(malformedFrame.cancelled()).toBe("Gateway service request failed");

    const malformedInstallation = requestFrameWithTrackedBody("malformed-installation");
    await expect(callServiceFrame(
      gateway,
      { installationId: "../invalid" },
      malformedInstallation.frame,
    )).resolves.toBeNull();
    expect(malformedInstallation.cancelled()).toBe("Gateway service request failed");

    const extraArgument = requestFrameWithTrackedBody("extra-argument");
    await expect(callServiceFrame(
      gateway,
      { installationId: "inst_rpc_compat" },
      extraArgument.frame,
      null,
    )).resolves.toBeNull();
    expect(extraArgument.cancelled()).toBe("Gateway service request failed");
    expect(getByName).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("derives an attenuated peer for a legacy generic adapter binding", async () => {
    const response = {
      type: "res" as const,
      id: "legacy-binding",
      ok: true,
      data: { routed: true },
    };
    const peerFrame = vi.fn(async () => response);
    const getByName = vi.fn(() => ({ peerFrame }));
    const gateway = genericGatewayWithEnv({ KERNEL: { getByName } });
    const frame = requestFrame("legacy-binding");

    await expect(gateway.serviceFrame(frame)).resolves.toEqual(response);
    expect(peerFrame).toHaveBeenCalledWith(
      { id: "telegram", calls: ["adapter.inbound", "adapter.state.update"] },
      frame,
    );
  });

  it("rejects an unknown identity on a legacy generic adapter binding", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = requestFrameWithTrackedBody("unknown-adapter");
    if (request.frame.type === "req") {
      request.frame.args = { adapter: "unknown" };
    }
    const getByName = vi.fn();
    const gateway = genericGatewayWithEnv({ KERNEL: { getByName } });

    await expect(gateway.serviceFrame(request.frame)).resolves.toBeNull();
    expect(request.cancelled()).toBe("Gateway service request failed");
    expect(getByName).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
