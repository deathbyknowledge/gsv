import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import {
  handleSysLink,
  handleSysLinkConsume,
  handleSysLinkList,
  handleSysUnlink,
} from "./sys-link";

type FakeAdapters = {
  identityLinks: {
    link: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  linkChallenges: {
    consume: ReturnType<typeof vi.fn>;
  };
};

function makeContext(uid: number, adapters: FakeAdapters): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
      },
      capabilities: ["*"],
    },
    adapters,
  } as unknown as KernelContext;
}

describe("sys.link handlers", () => {
  let adapters: FakeAdapters;

  beforeEach(() => {
    adapters = {
      identityLinks: {
        link: vi.fn((adapter, accountId, actorId, uid, linkedByUid) => ({
          adapter,
          accountId,
          actorId,
          uid,
          linkedByUid,
          createdAt: 1_700_000_000_000,
        })),
        get: vi.fn(),
        unlink: vi.fn(() => true),
        list: vi.fn(() => []),
      },
      linkChallenges: {
        consume: vi.fn(),
      },
    };
  });

  it("links to caller uid by default", () => {
    const ctx = makeContext(1000, adapters);
    const result = handleSysLink(
      {
        adapter: "WhatsApp",
        accountId: "default",
        actorId: "wa:+123",
      },
      ctx,
    );

    expect(adapters.identityLinks.link).toHaveBeenCalledWith(
      "whatsapp",
      "default",
      "wa:+123",
      1000,
      1000,
    );
    expect(result.link?.uid).toBe(1000);
  });

  it("allows root to link for another uid", () => {
    const ctx = makeContext(0, adapters);
    const result = handleSysLink(
      {
        adapter: "discord",
        accountId: "guild-a",
        actorId: "discord:user:42",
        uid: 2001,
      },
      ctx,
    );

    expect(adapters.identityLinks.link).toHaveBeenCalledWith(
      "discord",
      "guild-a",
      "discord:user:42",
      2001,
      0,
    );
    expect(result.link?.uid).toBe(2001);
  });

  it("rejects non-root linking for another uid", () => {
    const ctx = makeContext(1000, adapters);
    expect(() =>
      handleSysLink(
        {
          adapter: "discord",
          accountId: "guild-a",
          actorId: "discord:user:42",
          uid: 2001,
        },
        ctx,
      ),
    ).toThrow("Permission denied");
  });

  it("unlinks when caller owns the link", () => {
    const ctx = makeContext(1000, adapters);
    adapters.identityLinks.get.mockReturnValue({
      adapter: "whatsapp",
      accountId: "default",
      actorId: "wa:+123",
      uid: 1000,
      linkedByUid: 1000,
      createdAt: 1_700_000_000_000,
      metadata: null,
    });

    const result = handleSysUnlink(
      {
        adapter: "whatsapp",
        accountId: "default",
        actorId: "wa:+123",
      },
      ctx,
    );

    expect(result.removed).toBe(true);
    expect(adapters.identityLinks.unlink).toHaveBeenCalledWith(
      "whatsapp",
      "default",
      "wa:+123",
    );
  });

  it("rejects unlink when non-root does not own target link", () => {
    const ctx = makeContext(1000, adapters);
    adapters.identityLinks.get.mockReturnValue({
      adapter: "whatsapp",
      accountId: "default",
      actorId: "wa:+123",
      uid: 2001,
      linkedByUid: 0,
      createdAt: 1_700_000_000_000,
      metadata: null,
    });

    expect(() =>
      handleSysUnlink(
        {
          adapter: "whatsapp",
          accountId: "default",
          actorId: "wa:+123",
        },
        ctx,
      ),
    ).toThrow("Permission denied");
  });

  it("lists only caller uid links for non-root by default", () => {
    const ctx = makeContext(1000, adapters);
    adapters.identityLinks.list.mockReturnValue([
      {
        adapter: "whatsapp",
        accountId: "default",
        actorId: "wa:+111",
        uid: 1000,
        linkedByUid: 1000,
        createdAt: 1_700_000_000_000,
        metadata: null,
      },
    ]);

    const result = handleSysLinkList({}, ctx);
    expect(adapters.identityLinks.list).toHaveBeenCalledWith(1000);
    expect(result.links).toHaveLength(1);
  });

  it("allows root to list links for any uid", () => {
    const ctx = makeContext(0, adapters);
    adapters.identityLinks.list.mockReturnValue([]);

    handleSysLinkList({ uid: 2001 }, ctx);
    expect(adapters.identityLinks.list).toHaveBeenCalledWith(2001);
  });

  it("consumes challenge code and creates link for caller", () => {
    const ctx = makeContext(1000, adapters);
    adapters.linkChallenges.consume.mockReturnValue({
      code: "ABCD-1234",
      adapter: "whatsapp",
      accountId: "default",
      actorId: "wa:+123",
      surfaceKind: "dm",
      surfaceId: "wa:+123",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_600_000,
      usedAt: 1_700_000_010_000,
      usedByUid: 1000,
    });

    const result = handleSysLinkConsume({ code: "abcd-1234" }, ctx);
    expect(adapters.linkChallenges.consume).toHaveBeenCalledWith("ABCD-1234", 1000);
    expect(adapters.identityLinks.link).toHaveBeenCalled();
    expect(result.linked).toBe(true);
  });

  it("fails consume with invalid/expired code", () => {
    const ctx = makeContext(1000, adapters);
    adapters.linkChallenges.consume.mockReturnValue(null);

    expect(() => handleSysLinkConsume({ code: "nope" }, ctx)).toThrow(
      "Invalid or expired link code",
    );
  });
});
