import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { handleSysLinkList } from "./link";

type FakeAdapters = {
  identityLinks: {
    list: ReturnType<typeof vi.fn>;
  };
};

function makeContext(uid: number, adapters: FakeAdapters): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    peer: testPeer({ kind: "human", account: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
      }, calls: ["*"] }),
    adapters,
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

describe("sys.link.list", () => {
  let adapters: FakeAdapters;

  beforeEach(() => {
    adapters = {
      identityLinks: {
        list: vi.fn(() => []),
      },
    };
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
});
