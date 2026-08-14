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
const ACTIVITY: AdapterActivity = { kind: "typing", active: true };
const MESSAGE: AdapterOutboundMessage = {
  deliveryId: "delivery-1",
  surface: SURFACE,
  text: "hello",
};
const BODY: BinaryBody = { stream: new ReadableStream(), length: 0 };

function trackedBody(): { body: BinaryBody; cancelled: () => unknown } {
  let cancelled: unknown;
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
    const args = [
      { installationId: "../invalid" },
      "account",
      MESSAGE,
      request.body,
    ] as unknown as AdapterSendRpcArgs;

    await expect(representativeAdapterSend(...args))
      .rejects.toThrow("Adapter installation context is invalid");
    expect(request.cancelled()).toBeInstanceOf(Error);
    expect((request.cancelled() as Error).message)
      .toBe("Adapter installation context is invalid");
  });

  it("rejects ambiguous overload arities instead of reinterpreting them", () => {
    expect(() => resolveAdapterConnectRpcArgs([
      "account",
      {},
      {},
    ] as unknown as AdapterConnectRpcArgs)).toThrow("RPC arguments are invalid");
    expect(() => resolveAdapterDisconnectRpcArgs([
      "installation",
      "account",
    ] as unknown as AdapterDisconnectRpcArgs)).toThrow("RPC arguments are invalid");
    expect(() => resolveAdapterStatusRpcArgs([
      "installation",
      "account",
    ] as unknown as AdapterStatusRpcArgs)).toThrow("RPC arguments are invalid");
    expect(() => resolveAdapterActivityRpcArgs([
      "installation",
      "account",
      SURFACE,
      ACTIVITY,
    ] as unknown as AdapterActivityRpcArgs)).toThrow("RPC arguments are invalid");
  });

  it("cancels every possible send body slot when overload discrimination fails", async () => {
    const fourthArgument = trackedBody();
    await expect(representativeAdapterSend(...([
      "installation",
      "account",
      MESSAGE,
      fourthArgument.body,
    ] as unknown as AdapterSendRpcArgs))).rejects.toThrow("RPC arguments are invalid");
    expect(fourthArgument.cancelled()).toBeInstanceOf(Error);

    const thirdArgument = trackedBody();
    await expect(representativeAdapterSend(...([
      123,
      MESSAGE,
      thirdArgument.body,
    ] as unknown as AdapterSendRpcArgs))).rejects.toThrow(
      "Adapter installation context is invalid",
    );
    expect(thirdArgument.cancelled()).toBeInstanceOf(Error);
  });
});
