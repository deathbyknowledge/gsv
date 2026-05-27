import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import {
  adapterTargetId,
  listVisibleAdapterTargets,
  parseAdapterTargetId,
} from "./adapter-targets";

function makeContext(options: {
  uid?: number;
  env?: Record<string, unknown>;
  links?: Array<{ adapter: string; accountId: string; uid: number }>;
  statuses?: Array<{ adapter: string; accountId: string; connected: boolean; authenticated: boolean }>;
}): KernelContext {
  const uid = options.uid ?? 1000;
  const statuses = options.statuses ?? [];
  return {
    env: options.env ?? {},
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : "sam",
        home: uid === 0 ? "/root" : "/home/sam",
        cwd: uid === 0 ? "/root" : "/home/sam",
      },
      capabilities: ["*"],
    },
    adapters: {
      identityLinks: {
        list: vi.fn((filterUid?: number) =>
          (options.links ?? [])
            .filter((link) => filterUid === undefined || link.uid === filterUid)
            .map((link) => ({
              ...link,
              actorId: "actor-1",
              createdAt: 1,
              linkedByUid: link.uid,
              metadata: null,
            }))
        ),
      },
      status: {
        list: vi.fn((adapter: string, accountId?: string) =>
          statuses
            .filter((status) =>
              status.adapter === adapter && (accountId === undefined || status.accountId === accountId)
            )
            .map((status) => ({
              ...status,
              mode: "test",
              updatedAt: 2,
            }))
        ),
        listAll: vi.fn(() =>
          statuses.map((status) => ({
            ...status,
            mode: "test",
            updatedAt: 2,
          }))
        ),
      },
    },
  } as unknown as KernelContext;
}

describe("adapter target helpers", () => {
  it("round-trips encoded adapter target ids", () => {
    const targetId = adapterTargetId("WhatsApp", "primary:phone");

    expect(targetId).toBe("adapter:whatsapp:primary%3Aphone");
    expect(parseAdapterTargetId(targetId)).toEqual({
      adapter: "whatsapp",
      accountId: "primary:phone",
    });
  });

  it("lists connected authenticated adapter command targets linked to the user", () => {
    const ctx = makeContext({
      env: {
        CHANNEL_WHATSAPP: { adapterShellExec: vi.fn() },
      },
      links: [{ adapter: "whatsapp", accountId: "primary", uid: 1000 }],
      statuses: [
        { adapter: "whatsapp", accountId: "primary", connected: true, authenticated: true },
        { adapter: "discord", accountId: "primary", connected: true, authenticated: true },
      ],
    });

    const targets = listVisibleAdapterTargets(ctx);

    expect(targets.map((target) => target.targetId)).toEqual(["adapter:whatsapp:primary"]);
    expect(targets[0].label).toBe("WhatsApp");
  });

  it("hides adapters without shell command support", () => {
    const ctx = makeContext({
      env: {
        CHANNEL_WHATSAPP: {},
      },
      links: [{ adapter: "whatsapp", accountId: "primary", uid: 1000 }],
      statuses: [
        { adapter: "whatsapp", accountId: "primary", connected: true, authenticated: true },
      ],
    });

    expect(listVisibleAdapterTargets(ctx)).toEqual([]);
  });

  it("lists offline authenticated adapter command targets when requested", () => {
    const ctx = makeContext({
      env: {
        CHANNEL_WHATSAPP: { adapterShellExec: vi.fn() },
      },
      links: [{ adapter: "whatsapp", accountId: "primary", uid: 1000 }],
      statuses: [
        { adapter: "whatsapp", accountId: "primary", connected: false, authenticated: true },
      ],
    });

    expect(listVisibleAdapterTargets(ctx)).toEqual([]);
    expect(listVisibleAdapterTargets(ctx, { includeOffline: true }).map((target) => target.targetId)).toEqual([
      "adapter:whatsapp:primary",
    ]);
  });

  it("does not list unauthenticated adapter targets in offline mode", () => {
    const ctx = makeContext({
      env: {
        CHANNEL_WHATSAPP: { adapterShellExec: vi.fn() },
      },
      links: [{ adapter: "whatsapp", accountId: "primary", uid: 1000 }],
      statuses: [
        { adapter: "whatsapp", accountId: "primary", connected: false, authenticated: false },
      ],
    });

    expect(listVisibleAdapterTargets(ctx, { includeOffline: true })).toEqual([]);
  });

  it("lets root see all connected authenticated adapter command targets", () => {
    const ctx = makeContext({
      uid: 0,
      env: {
        CHANNEL_DISCORD: { adapterShellExec: vi.fn() },
      },
      statuses: [
        { adapter: "discord", accountId: "ops", connected: true, authenticated: true },
      ],
    });

    expect(listVisibleAdapterTargets(ctx).map((target) => target.targetId)).toEqual(["adapter:discord:ops"]);
  });
});
