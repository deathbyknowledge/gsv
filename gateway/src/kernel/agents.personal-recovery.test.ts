import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";

const { ensureAccountHomeLayoutMock, seedPersonaMock } = vi.hoisted(() => ({
  ensureAccountHomeLayoutMock: vi.fn(),
  seedPersonaMock: vi.fn(),
}));

vi.mock("./account-home", async (importOriginal) => {
  const original = await importOriginal<typeof import("./account-home")>();
  return {
    ...original,
    ensureAccountHomeLayout: ensureAccountHomeLayoutMock,
  };
});

vi.mock("./accounts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./accounts")>();
  return {
    ...original,
    seedPersona: seedPersonaMock,
  };
});

import { ensurePersonalAgent } from "./agents";

describe("ensurePersonalAgent interrupted provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAccountHomeLayoutMock.mockResolvedValue(undefined);
    seedPersonaMock.mockResolvedValue(undefined);
  });

  it("finishes home and persona seeding for an already committed personal-agent mapping", async () => {
    const agent = {
      username: "mira",
      uid: 1001,
      gid: 1001,
      gecos: "Mira",
      home: "/home/mira",
      shell: "/bin/init",
    };
    const auth = {
      isPersonalAgentUid: vi.fn(() => false),
      getPersonalAgentUid: vi.fn(() => 1001),
      getPasswdByUid: vi.fn((uid: number) => uid === 1001 ? agent : null),
      resolveGids: vi.fn(() => [1001, 100]),
    };
    const ctx = {
      auth: auth as unknown as KernelContext["auth"],
      env: { STORAGE: {} as R2Bucket } as Env,
    } as KernelContext;
    const human = {
      username: "alice",
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      home: "/home/alice",
      cwd: "/home/alice",
    };

    await expect(ensurePersonalAgent(ctx, human, "mira")).resolves.toMatchObject({
      created: false,
      identity: { username: "mira", uid: 1001 },
    });
    expect(ensureAccountHomeLayoutMock).toHaveBeenCalledWith(
      ctx.env,
      expect.objectContaining({ username: "mira", home: "/home/mira" }),
      expect.objectContaining({ userContextUsername: "alice", seedPromptContext: true }),
    );
    expect(seedPersonaMock).toHaveBeenCalledWith(
      ctx.env,
      expect.objectContaining({ username: "mira" }),
      expect.stringContaining("mira"),
    );
  });
});
