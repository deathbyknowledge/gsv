import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KernelContext } from "./context";
import {
  handleAdapterConnect,
  handleAdapterDisconnect,
  handleAdapterInbound,
} from "./adapter-handlers";
import { sendFrameToProcess } from "../shared/utils";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

type FakeAdapterStatusStore = {
  upsert: ReturnType<typeof vi.fn>;
};

function makeContext(
  env: Record<string, unknown>,
  status: FakeAdapterStatusStore,
): KernelContext {
  return {
    env,
    auth: {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "sam",
        home: "/home/sam",
      })),
      resolveGids: vi.fn(() => [1000]),
    },
    procs: {
      ensureInit: vi.fn(() => ({ pid: "pid-1", created: false })),
      get: vi.fn(() => ({ uid: 1000 })),
    },
    adapters: {
      status,
      identityLinks: {
        resolveUid: vi.fn(() => 1000),
      },
      linkChallenges: {
        issue: vi.fn(() => ({
          code: "ABCD",
          expiresAt: Date.now() + 60_000,
        })),
      },
      surfaceRoutes: {
        resolvePid: vi.fn(() => "pid-1"),
      },
    },
    identity: {
      role: "service",
      service: "test",
      capabilities: [],
    },
  } as unknown as KernelContext;
}

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("adapter lifecycle handlers", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
  });

  it("adapter.connect returns connect challenge payload and refreshes status", async () => {
    const service = {
      adapterConnect: vi.fn(async () => ({
        ok: true as const,
        message: "Scan QR code",
        connected: true,
        authenticated: false,
        challenge: {
          type: "qr",
          data: "qr-payload",
          message: "Scan QR code",
        },
      })),
      adapterStatus: vi.fn(async () => [
        {
          accountId: "default",
          connected: true,
          authenticated: false,
          mode: "websocket",
        },
      ]),
    };

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterConnect(
      { adapter: "whatsapp", accountId: "default" },
      ctx,
    );

    expect(service.adapterConnect).toHaveBeenCalledWith("default", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.challenge?.type).toBe("qr");
      expect(result.connected).toBe(true);
      expect(result.authenticated).toBe(false);
    }
    expect(status.upsert).toHaveBeenCalled();
  });

  it("adapter.connect returns error when binding does not implement connect", async () => {
    const service = {
      start: vi.fn(async () => ({ ok: true as const })),
    };

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_DISCORD: service,
      },
      status,
    );

    const result = await handleAdapterConnect(
      { adapter: "discord", accountId: "default", config: { botToken: "x" } },
      ctx,
    );

    expect(service.start).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not implement connect");
    }
  });

  it("adapter.disconnect calls disconnect and refreshes status", async () => {
    const service = {
      adapterDisconnect: vi.fn(async () => ({ ok: true as const })),
      adapterStatus: vi.fn(async () => [
        {
          accountId: "default",
          connected: false,
          authenticated: false,
          mode: "disconnected",
        },
      ]),
    };

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterDisconnect(
      { adapter: "whatsapp", accountId: "default" },
      ctx,
    );

    expect(service.adapterDisconnect).toHaveBeenCalledWith("default");
    expect(result).toMatchObject({
      ok: true,
      adapter: "whatsapp",
      accountId: "default",
    });
    expect(status.upsert).toHaveBeenCalled();
  });

  it("returns an error when adapter binding is missing", async () => {
    const status = { upsert: vi.fn() };
    const ctx = makeContext({}, status);

    const result = await handleAdapterConnect(
      { adapter: "unknown", accountId: "default" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Adapter service unavailable");
    }
  });

  it("adapter.inbound returns a reminder when a confirmation is pending", async () => {
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "history-1",
      ok: true,
      data: {
        pendingHil: {
          requestId: "hil-1",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "~/secret.txt", target: "gsv" },
        },
      },
    } as any);

    const service = {
      adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
    };
    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-1",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "what's going on?",
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      reply: {
        replyToId: "msg-1",
      },
    });
    expect(result.reply?.text).toContain('Reply "approve" or "deny"');
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(1);
  });

  it("adapter.inbound accepts approve in dm while a confirmation is pending", async () => {
    const service = {
      adapterSetActivity: vi.fn(async () => ({ ok: true as const })),
    };
    sendFrameToProcessMock
      .mockResolvedValueOnce({
        type: "res",
        id: "history-1",
        ok: true,
        data: {
          pendingHil: {
            requestId: "hil-2",
            toolName: "Read",
            syscall: "fs.read",
            args: { path: "~/secret.txt", target: "gsv" },
          },
        },
      } as any)
      .mockResolvedValueOnce({
        type: "res",
        id: "hil-2",
        ok: true,
        data: {
          ok: true,
          pid: "pid-1",
          requestId: "hil-2",
          decision: "approve",
          resumed: true,
          pendingHil: null,
        },
      } as any);

    const status = { upsert: vi.fn() };
    const ctx = makeContext(
      {
        CHANNEL_WHATSAPP: service,
      },
      status,
    );

    const result = await handleAdapterInbound(
      {
        adapter: "whatsapp",
        accountId: "primary",
        message: {
          messageId: "msg-2",
          surface: { kind: "dm", id: "dm-1" },
          actor: { id: "wa:+123" },
          text: "approve",
        },
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      reply: {
        text: "Approved. Continuing.",
        replyToId: "msg-2",
      },
    });
    expect(service.adapterSetActivity).toHaveBeenCalledWith(
      "primary",
      { kind: "dm", id: "dm-1" },
      { kind: "typing", active: true },
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(2);
  });
});
