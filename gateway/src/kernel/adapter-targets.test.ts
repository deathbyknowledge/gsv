import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import {
  adapterTargetId,
  listVisibleAdapterTargets,
  parseAdapterTargetId,
} from "./adapter-targets";

function makeContext(options: {
  uid?: number;
  ownerUid?: number;
  processId?: string;
  env?: Record<string, unknown>;
  links?: Array<{ adapter: string; accountId: string; uid: number }>;
  statuses?: Array<{ adapter: string; accountId: string; connected: boolean; authenticated: boolean }>;
}): KernelContext {
  const uid = options.uid ?? 1000;
  const ownerUid = options.ownerUid ?? uid;
  const statuses = options.statuses ?? [];
  return {
    env: options.env ?? {},
    processId: options.processId,
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
    procs: {
      getOwnerUid: vi.fn((processId: string) =>
        processId === options.processId ? ownerUid : null
      ),
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
        listByOwner: vi.fn(() => []),
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

  it("lists connected authenticated adapter messaging targets linked to the user", () => {
    const ctx = makeContext({
      env: {
        CHANNEL_WHATSAPP: { adapterSend: vi.fn() },
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

  it("lists owner-linked adapter messaging targets for agent process callers", () => {
    const ctx = makeContext({
      uid: 2000,
      ownerUid: 1000,
      processId: "proc-agent",
      env: {
        CHANNEL_TELEGRAM: { adapterSend: vi.fn() },
      },
      links: [{ adapter: "telegram", accountId: "bot", uid: 1000 }],
      statuses: [
        { adapter: "telegram", accountId: "bot", connected: true, authenticated: true },
      ],
    });

    const targets = listVisibleAdapterTargets(ctx);

    expect(ctx.adapters.identityLinks.list).toHaveBeenCalledWith(1000);
    expect(targets.map((target) => target.targetId)).toEqual(["adapter:telegram:bot"]);
  });

  it("hides adapters without message delivery support", () => {
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

  it("lists offline authenticated adapter messaging targets when requested", () => {
    const ctx = makeContext({
      env: {
        CHANNEL_WHATSAPP: { adapterSend: vi.fn() },
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
        CHANNEL_WHATSAPP: { adapterSend: vi.fn() },
      },
      links: [{ adapter: "whatsapp", accountId: "primary", uid: 1000 }],
      statuses: [
        { adapter: "whatsapp", accountId: "primary", connected: false, authenticated: false },
      ],
    });

    expect(listVisibleAdapterTargets(ctx, { includeOffline: true })).toEqual([]);
  });

  it("lets root see all connected authenticated adapter messaging targets", () => {
    const ctx = makeContext({
      uid: 0,
      env: {
        CHANNEL_DISCORD: { adapterSend: vi.fn() },
      },
      statuses: [
        { adapter: "discord", accountId: "ops", connected: true, authenticated: true },
      ],
    });

    expect(listVisibleAdapterTargets(ctx).map((target) => target.targetId)).toEqual(["adapter:discord:ops"]);
  });
});
