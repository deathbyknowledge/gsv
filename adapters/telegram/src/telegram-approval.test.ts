import { describe, expect, it, vi } from "vitest";

import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import type { AdapterPeerDeliveryContext } from "./types";
import {
  handleTelegramApprovalCallback,
  prepareTelegramApproval,
} from "./telegram-approval";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()].filter(
        ([key]) => !options?.prefix || key.startsWith(options.prefix),
      ),
    ) as Map<string, T>;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce(
        (count, item) => count + (this.values.delete(item) ? 1 : 0),
        0,
      );
    }
    return this.values.delete(key);
  }

  async transaction<T>(closure: (txn: MemoryStorage) => Promise<T>): Promise<T> {
    return await closure(this);
  }
}

const CONTEXT: AdapterPeerDeliveryContext = {
  deliveryId: "run-1:hil:request-1",
  accountId: "telegram-account-1",
  actorId: "12345",
  surface: { kind: "dm", id: "12345" },
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

describe("Telegram structured approvals", () => {
  it("turns a button into an ordinary linked-human proc.hil request exactly once", async () => {
    const storage = new MemoryStorage();
    const controls = await prepareTelegramApproval(
      storage as unknown as DurableObjectStorage,
      CONTEXT,
      REQUEST,
    );
    if (!controls) throw new Error("expected Telegram controls");

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
    const api = {
      answerCallbackQuery: vi.fn(async () => undefined),
      clearInlineKeyboard: vi.fn(async () => undefined),
    };
    const callback = {
      callbackQueryId: "callback-1",
      actorId: "12345",
      surfaceId: "12345",
      providerMessageId: "42",
      data: controls.replyMarkup.inline_keyboard[0]![1]!.callback_data,
    };

    await handleTelegramApprovalCallback(
      storage as unknown as DurableObjectStorage,
      gateway,
      { installationId: "inst_test" },
      callback,
      api,
    );
    expect(linkedPeerFrame).toHaveBeenCalledWith(
      { installationId: "inst_test" },
      {
        accountId: "telegram-account-1",
        actorId: "12345",
        surface: { kind: "dm", id: "12345" },
        routeGeneration: "route-generation-1",
        interactionId: "callback-1",
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
    expect(api.clearInlineKeyboard).toHaveBeenCalledWith("12345", "42");

    await handleTelegramApprovalCallback(
      storage as unknown as DurableObjectStorage,
      gateway,
      { installationId: "inst_test" },
      callback,
      api,
    );
    expect(linkedPeerFrame).toHaveBeenCalledTimes(1);
  });
});
