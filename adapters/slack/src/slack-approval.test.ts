import { describe, expect, it, vi } from "vitest";

import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import type { AdapterPeerDeliveryContext } from "./types";
import {
  handleSlackApprovalCallback,
  prepareSlackApproval,
} from "./slack-approval";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix)),
    ) as Map<string, T>;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce((count, item) => count + (this.values.delete(item) ? 1 : 0), 0);
    }
    return this.values.delete(key);
  }

  async transaction<T>(closure: (txn: MemoryStorage) => Promise<T>): Promise<T> {
    return await closure(this);
  }
}

const CONTEXT: AdapterPeerDeliveryContext = {
  deliveryId: "run-1:hil:request-1",
  accountId: "workspace-1",
  actorId: "UALICE01",
  surface: { kind: "dm", id: "DALICE01" },
  routeGeneration: "route-generation-1",
  processId: "proc-1",
  runId: "run-1",
};
const REQUEST = {
  pid: "proc-1",
  requestId: "request-1",
  runId: "run-1",
  callId: "call-1",
  toolName: "Shell",
  syscall: "shell.exec",
  target: "gsv",
  args: { command: "date" },
  createdAt: 1,
} as const;

describe("Slack structured approvals", () => {
  it("turns a button into an ordinary linked-human proc.hil request exactly once", async () => {
    const storage = new MemoryStorage();
    const controls = await prepareSlackApproval(
      storage as unknown as DurableObjectStorage,
      "TWORK123",
      CONTEXT,
      REQUEST,
      "Run shell.exec on gsv?",
    );
    if (!controls) throw new Error("expected Slack controls");

    const linkedPeerFrame = vi.fn(async (_installation, _context, frame) => ({
      type: "res" as const,
      id: frame.id,
      ok: true,
      data: {
        ok: true,
        pid: "proc-1",
        requestId: "request-1",
        decision: "approve",
        resumed: true,
        remembered: true,
      },
    }));
    const gateway = {
      serviceFrame: vi.fn(),
      linkedPeerFrame,
    } as unknown as AdapterGatewayBinding;
    const updateMessage = vi.fn(async () => undefined);
    const callback = {
      deliveryId: "interaction:1:2",
      interactionId: "interaction:2",
      teamId: "TWORK123",
      actorId: "UALICE01",
      surface: { kind: "dm" as const, id: "DALICE01" },
      sourceMessageId: "1700000000.000100",
      sourceText: "Run shell.exec on gsv?",
      action: "approve_always" as const,
      token: controls.token,
    };

    await handleSlackApprovalCallback(
      storage as unknown as DurableObjectStorage,
      gateway,
      { installationId: "inst_test" },
      callback,
      { updateMessage },
    );
    expect(linkedPeerFrame).toHaveBeenCalledWith(
      { installationId: "inst_test" },
      {
        accountId: "workspace-1",
        actorId: "UALICE01",
        surface: { kind: "dm", id: "DALICE01" },
        routeGeneration: "route-generation-1",
        interactionId: "interaction:2",
      },
      expect.objectContaining({
        type: "req",
        call: "proc.hil",
        args: {
          pid: "proc-1",
          requestId: "request-1",
          decision: "approve",
          remember: true,
        },
      }),
    );
    expect(updateMessage).toHaveBeenCalledWith(
      callback,
      expect.objectContaining({ text: expect.stringContaining("Always approve") }),
    );

    await handleSlackApprovalCallback(
      storage as unknown as DurableObjectStorage,
      gateway,
      { installationId: "inst_test" },
      callback,
      { updateMessage },
    );
    expect(linkedPeerFrame).toHaveBeenCalledTimes(1);
  });
});
