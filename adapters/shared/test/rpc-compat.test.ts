import { describe, expect, it } from "vitest";

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
} from "../src/rpc-compat";
import type {
  AdapterActivity,
  AdapterOutboundMessage,
  AdapterSurface,
  BinaryBody,
} from "../src/types";

const INSTALLATION = { installationId: "inst_rpc_compat" } as const;
const SURFACE: AdapterSurface = { kind: "dm", id: "dm-1" };
const ACTIVITY: AdapterActivity = {
  kind: "typing",
  active: true,
  routeGeneration: "generation-1",
};
const MESSAGE: AdapterOutboundMessage = {
  deliveryId: "delivery-1",
  surface: SURFACE,
  text: "hello",
};
const BODY: BinaryBody = { stream: new ReadableStream(), length: 0 };

type TrackedBody = { body: BinaryBody; cancelled: () => Error | string | undefined };

function trackedBody(): TrackedBody {
  let cancelled: Error | string | undefined;
  return {
    body: {
      stream: new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelled = reason;
        },
      }),
    },
    cancelled: () => cancelled,
  };
}

async function representativeAdapterSend(...args: AdapterSendRpcArgs) {
  return await resolveAdapterSendRpcArgs(args);
}

describe("adapter RPC compatibility", () => {
  it("accepts pre-managed Gateway calls as standalone", async () => {
    expect(resolveAdapterConnectRpcArgs(["account", { token: "test" }]))
      .toEqual({
        installation: { installationId: "singleton" },
        accountId: "account",
        config: { token: "test" },
      });
    expect(resolveAdapterDisconnectRpcArgs(["account"]))
      .toEqual({ installation: { installationId: "singleton" }, accountId: "account" });
    expect(resolveAdapterStatusRpcArgs([]))
      .toEqual({ installation: { installationId: "singleton" } });
    expect(await resolveAdapterSendRpcArgs(["account", MESSAGE, BODY]))
      .toEqual({
        installation: { installationId: "singleton" },
        accountId: "account",
        message: MESSAGE,
        body: BODY,
      });
    expect(resolveAdapterActivityRpcArgs(["account", SURFACE, ACTIVITY]))
      .toEqual({
        installation: { installationId: "singleton" },
        accountId: "account",
        surface: SURFACE,
        activity: ACTIVITY,
      });
// SAFETY: This test fixture deliberately supplies the contract shape under test.
  });

  it("accepts already-deployed managed Gateway calls without reinterpretation", async () => {
    expect(resolveAdapterConnectRpcArgs([INSTALLATION, "account", { token: "test" }]))
      .toEqual({
        installation: INSTALLATION,
        accountId: "account",
        config: { token: "test" },
      });
    expect(resolveAdapterDisconnectRpcArgs([INSTALLATION, "account"]))
      .toEqual({ installation: INSTALLATION, accountId: "account" });
    expect(resolveAdapterStatusRpcArgs([INSTALLATION, "account"]))
      .toEqual({ installation: INSTALLATION, accountId: "account" });
    expect(await resolveAdapterSendRpcArgs([INSTALLATION, "account", MESSAGE, BODY]))
      .toEqual({
        installation: INSTALLATION,
        accountId: "account",
        message: MESSAGE,
        body: BODY,
      });
    expect(resolveAdapterActivityRpcArgs([
      INSTALLATION,
      "account",
      SURFACE,
      ACTIVITY,
    ])).toEqual({
      installation: INSTALLATION,
      accountId: "account",
      surface: SURFACE,
      activity: ACTIVITY,
    });
  });

  it("cancels a scoped send body before a wrapper rejects malformed identity", async () => {
    const request = trackedBody();
// SAFETY: This test fixture deliberately supplies the contract shape under test.
    const args = [
      { installationId: "../invalid" },
      "account",
// SAFETY: This test fixture deliberately supplies the contract shape under test.
      MESSAGE,
      request.body,
    ] as AdapterSendRpcArgs;

    await expect(representativeAdapterSend(...args))
      .rejects.toThrow("Adapter installation context is invalid");
// SAFETY: This test fixture deliberately supplies the contract shape under test.
    expect(request.cancelled()).toBeInstanceOf(Error);
// SAFETY: This test fixture deliberately supplies the contract shape under test.
    expect((request.cancelled() as Error).message)
      .toBe("Adapter installation context is invalid");
  });

// SAFETY: This test fixture deliberately supplies the contract shape under test.
  it("rejects ambiguous overload arities instead of reinterpreting them", () => {
    // SAFETY: malformed overload fixture intentionally violates the adapter argument contract.
    const connectArgs = ["account", {}, {}] as AdapterConnectRpcArgs;
    expect(() => resolveAdapterConnectRpcArgs(connectArgs)).toThrow("RPC arguments are invalid");
    // SAFETY: malformed overload fixture intentionally violates the adapter argument contract.
    const disconnectArgs = ["installation", "account"] as AdapterDisconnectRpcArgs;
    expect(() => resolveAdapterDisconnectRpcArgs(disconnectArgs)).toThrow("RPC arguments are invalid");
    // SAFETY: malformed overload fixture intentionally violates the adapter argument contract.
    const statusArgs = ["installation", "account"] as AdapterStatusRpcArgs;
    expect(() => resolveAdapterStatusRpcArgs(statusArgs)).toThrow("RPC arguments are invalid");
    // SAFETY: malformed overload fixture intentionally violates the adapter argument contract.
    const activityArgs = ["installation", "account", SURFACE, ACTIVITY] as AdapterActivityRpcArgs;
    expect(() => resolveAdapterActivityRpcArgs(activityArgs)).toThrow("RPC arguments are invalid");
  });

  it("cancels every possible send body slot when overload discrimination fails", async () => {
    const fourthArgument = trackedBody();
    // SAFETY: malformed overload fixture intentionally violates the adapter argument contract.
    const fourthArgs = [
      "installation",
      "account",
      MESSAGE,
      fourthArgument.body,
    ] as AdapterSendRpcArgs;
    await expect(representativeAdapterSend(...fourthArgs)).rejects.toThrow("RPC arguments are invalid");
    expect(fourthArgument.cancelled()).toBeInstanceOf(Error);

    const thirdArgument = trackedBody();
    // SAFETY: malformed overload fixture intentionally violates the adapter argument contract.
    const thirdArgs = [
      123,
      MESSAGE,
      thirdArgument.body,
    ] as AdapterSendRpcArgs;
    await expect(representativeAdapterSend(...thirdArgs)).rejects.toThrow(
      "Adapter installation context is invalid",
    );
    expect(thirdArgument.cancelled()).toBeInstanceOf(Error);
  });
});
