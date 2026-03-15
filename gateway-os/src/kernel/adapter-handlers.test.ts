import { describe, it, expect, vi } from "vitest";
import type { KernelContext } from "./context";
import {
  handleAdapterConnect,
  handleAdapterDisconnect,
} from "./adapter-handlers";

type FakeAdapterStatusStore = {
  upsert: ReturnType<typeof vi.fn>;
};

function makeContext(
  env: Record<string, unknown>,
  status: FakeAdapterStatusStore,
): KernelContext {
  return {
    env,
    adapters: {
      status,
    },
  } as unknown as KernelContext;
}

describe("adapter lifecycle handlers", () => {
  it("adapter.connect falls back to login and returns QR challenge", async () => {
    const service = {
      login: vi.fn(async () => ({
        ok: true as const,
        qrDataUrl: "data:image/png;base64,abc123",
        message: "Scan QR code",
      })),
      status: vi.fn(async () => [
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

    expect(service.login).toHaveBeenCalledWith("default", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.challenge?.type).toBe("qr");
      expect(result.connected).toBe(true);
      expect(result.authenticated).toBe(false);
    }
    expect(status.upsert).toHaveBeenCalled();
  });

  it("adapter.connect falls back to start when connect/login are unavailable", async () => {
    const service = {
      start: vi.fn(async () => ({ ok: true as const })),
      status: vi.fn(async () => [
        {
          accountId: "default",
          connected: true,
          authenticated: true,
        },
      ]),
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

    expect(service.start).toHaveBeenCalledWith("default", { botToken: "x" });
    expect(result).toMatchObject({
      ok: true,
      adapter: "discord",
      accountId: "default",
      connected: true,
      authenticated: true,
    });
  });

  it("adapter.disconnect falls back to logout", async () => {
    const service = {
      logout: vi.fn(async () => ({ ok: true as const })),
      status: vi.fn(async () => [
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

    expect(service.logout).toHaveBeenCalledWith("default");
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
});
