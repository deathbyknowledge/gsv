import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import {
  handleSysTokenCreate,
  handleSysTokenList,
  handleSysTokenRevoke,
} from "./token";

type FakeAuth = {
  issueToken: ReturnType<typeof vi.fn>;
  listTokens: ReturnType<typeof vi.fn>;
  revokeToken: ReturnType<typeof vi.fn>;
};

function makeContext(uid: number, auth: FakeAuth): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    auth: auth as unknown as KernelContext["auth"],
  } as KernelContext;
}

describe("sys.token handlers", () => {
  let auth: FakeAuth;

  beforeEach(() => {
    auth = {
      issueToken: vi.fn(async (input) => ({
        tokenId: "tok-1",
        token: "gsv_node_example",
        tokenPrefix: "gsv_node_example",
        uid: input.uid as number,
        kind: input.kind as "node" | "service" | "user",
        label: (input.label as string | undefined) ?? null,
        allowedRole: (input.allowedRole as "driver" | "service" | "user") ?? null,
        allowedDeviceId: (input.allowedDeviceId as string | undefined) ?? null,
        createdAt: 1_700_000_000_000,
        expiresAt: (input.expiresAt as number | undefined) ?? null,
      })),
      listTokens: vi.fn(() => []),
      revokeToken: vi.fn(() => true),
    };
  });

  it("allows root to create a token for another uid", async () => {
    const ctx = makeContext(0, auth);

    const result = await handleSysTokenCreate(
      {
        uid: 1001,
        kind: "node",
        allowedDeviceId: "node-alpha",
      },
      ctx,
    );

    expect(auth.issueToken).toHaveBeenCalledWith({
      uid: 1001,
      kind: "node",
      label: undefined,
      allowedRole: "driver",
      allowedDeviceId: "node-alpha",
      expiresAt: undefined,
    });
    expect(result.token.uid).toBe(1001);
    expect(result.token.allowedRole).toBe("driver");
  });

  it("rejects non-root create for another uid", async () => {
    const ctx = makeContext(1000, auth);

    await expect(
      handleSysTokenCreate(
        {
          uid: 1001,
          kind: "node",
        },
        ctx,
      ),
    ).rejects.toThrow("Permission denied: cannot create tokens for another user");
    expect(auth.issueToken).not.toHaveBeenCalled();
  });

  it("rejects kind/role mismatch", async () => {
    const ctx = makeContext(0, auth);

    await expect(
      handleSysTokenCreate(
        {
          kind: "node",
          allowedRole: "service",
        },
        ctx,
      ),
    ).rejects.toThrow("Invalid allowedRole for kind=node: expected driver");
    expect(auth.issueToken).not.toHaveBeenCalled();
  });

  it("rejects past expiresAt", async () => {
    const ctx = makeContext(0, auth);

    await expect(
      handleSysTokenCreate(
        {
          kind: "user",
          expiresAt: Date.now() - 1,
        },
        ctx,
      ),
    ).rejects.toThrow("expiresAt must be in the future");
    expect(auth.issueToken).not.toHaveBeenCalled();
  });

  it("lists only own tokens for non-root callers", () => {
    const ctx = makeContext(1000, auth);

    handleSysTokenList({ uid: 1000 }, ctx);
    expect(auth.listTokens).toHaveBeenCalledWith(1000);
  });

  it("rejects non-root list for another uid", () => {
    const ctx = makeContext(1000, auth);

    expect(() => handleSysTokenList({ uid: 42 }, ctx)).toThrow(
      "Permission denied: cannot list tokens for another user",
    );
    expect(auth.listTokens).not.toHaveBeenCalled();
  });

  it("allows root to list all tokens", () => {
    const ctx = makeContext(0, auth);

    handleSysTokenList({}, ctx);
    expect(auth.listTokens).toHaveBeenCalledWith(undefined);
  });

  it("scopes non-root revoke to the caller uid", () => {
    const ctx = makeContext(1000, auth);

    const result = handleSysTokenRevoke(
      {
        tokenId: "tok-123",
      },
      ctx,
    );

    expect(result.revoked).toBe(true);
    expect(auth.revokeToken).toHaveBeenCalledWith("tok-123", undefined, 1000);
  });

  it("allows root revoke with optional uid filter", () => {
    const ctx = makeContext(0, auth);

    handleSysTokenRevoke(
      {
        tokenId: "tok-123",
        reason: "rotated",
        uid: 1001,
      },
      ctx,
    );

    expect(auth.revokeToken).toHaveBeenCalledWith("tok-123", "rotated", 1001);
  });
});
