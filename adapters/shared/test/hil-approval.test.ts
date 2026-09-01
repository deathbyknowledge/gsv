import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcHilRequest } from "../../../packages/gsv/src/protocol/syscalls/proc";
import type { AdapterGatewayBinding } from "../src/gateway-rpc";
import {
  prepareAdapterHilApproval,
  submitAdapterHilApproval,
  type AdapterHilCallback,
} from "../src/hil-approval";
import { runAdapterPeerSqlMigrations } from "../src/schema/migrations";
import type {
  AdapterInstallationContext,
  AdapterLinkedPeerContext,
  AdapterPeerDeliveryContext,
  GatewayFrame,
  GatewayRequestFrame,
} from "../src/types";
import { TestDurableObjectStorage } from "./sqlite-storage";

const INSTALLATION = { installationId: "inst_test" } as const;
const CONTEXT: AdapterPeerDeliveryContext = {
  deliveryId: "run-1:hil:request-1",
  accountId: "account-1",
  actorId: "actor-1",
  surface: { kind: "dm", id: "surface-1" },
  processId: "proc-1",
  runId: "run-1",
};
// SAFETY: Approval persistence reads only these request identity fields.
const REQUEST = {
  pid: "proc-1",
  requestId: "request-1",
  runId: "run-1",
} as ProcHilRequest;

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function callback(
  token: string,
  interactionId: string,
  decision: "approve" | "deny",
): AdapterHilCallback {
  return {
    provider: "telegram",
    token,
    actorId: "actor-1",
    surface: { kind: "dm", id: "surface-1" },
    providerMessageId: "message-1",
    interactionId,
    decision,
    remember: false,
  };
}

function response(frame: GatewayRequestFrame, ok: boolean): GatewayFrame {
  return {
    type: "res",
    id: frame.id,
    ok: true,
    data: ok
      ? {
          ok: true,
          pid: REQUEST.pid,
          requestId: REQUEST.requestId,
          decision: "approve",
          resumed: true,
          remembered: false,
          pendingHil: null,
        }
      : { ok: false, error: "Approval is no longer pending" },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adapter HIL approvals", () => {
  it("keeps the first decision across an expired attempt and retry", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const storage = new TestDurableObjectStorage();
    const durableStorage = storage.asDurableStorage();
    runAdapterPeerSqlMigrations(durableStorage);
    const token = await prepareAdapterHilApproval(
      durableStorage,
      "telegram",
      undefined,
      CONTEXT,
      REQUEST,
    );
    if (!token) throw new Error("expected an approval token");

    const firstResponse = deferred<GatewayFrame | null>();
    let calls = 0;
    const linkedPeerFrame = vi.fn(async (
      _installation: AdapterInstallationContext,
      _context: AdapterLinkedPeerContext,
      frame: GatewayRequestFrame,
    ) => {
      calls += 1;
      return calls === 1 ? await firstResponse.promise : response(frame, true);
    });
    // SAFETY: The fixture supplies the only Gateway method exercised here.
    const gateway = { linkedPeerFrame } as AdapterGatewayBinding;
    const submit = (interactionId: string, decision: "approve" | "deny") => (
      submitAdapterHilApproval(
        durableStorage,
        gateway,
        INSTALLATION,
        callback(token, interactionId, decision),
      )
    );

    const first = submit("interaction-1", "approve");
    await vi.waitFor(() => expect(linkedPeerFrame).toHaveBeenCalledOnce());

    now += 60_001;
    await expect(submit("interaction-2", "deny"))
      .resolves.toEqual({ kind: "processing" });
    expect(linkedPeerFrame).toHaveBeenCalledOnce();

    await expect(submit("interaction-3", "approve"))
      .resolves.toEqual({ kind: "submitted", resolution: "approve" });

    firstResponse.resolve(response(linkedPeerFrame.mock.calls[0]![2], false));
    await expect(first).resolves.toEqual({ kind: "submitted", resolution: "approve" });
    await expect(submit("interaction-4", "deny"))
      .resolves.toEqual({ kind: "resolved", resolution: "approve" });
    expect(linkedPeerFrame).toHaveBeenCalledTimes(2);
  });
});
