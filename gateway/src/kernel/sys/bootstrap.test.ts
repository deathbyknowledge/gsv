import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import { handleSysBootstrap } from "./bootstrap";

const { importFromUpstreamMock, buildBuiltinPackageSeedsMock } = vi.hoisted(() => ({
  importFromUpstreamMock: vi.fn(),
  buildBuiltinPackageSeedsMock: vi.fn(),
}));

const {
  inferDefaultCliChannelMock,
  mirrorCliChannelMock,
  storeDefaultCliChannelMock,
} = vi.hoisted(() => ({
  inferDefaultCliChannelMock: vi.fn(),
  mirrorCliChannelMock: vi.fn(),
  storeDefaultCliChannelMock: vi.fn(),
}));

vi.mock("../../fs/ripgit/client", () => ({
  RipgitClient: class {
    importFromUpstream = importFromUpstreamMock;
  },
}));

vi.mock("../packages", () => ({
  buildBuiltinPackageSeeds: buildBuiltinPackageSeedsMock,
}));

vi.mock("../../downloads/cli", () => ({
  CLI_BINARY_ASSETS: ["gsv-darwin-arm64", "gsv-linux-x64"],
  CLI_RELEASE_CHANNELS: ["stable", "dev"],
  inferDefaultCliChannel: inferDefaultCliChannelMock,
  mirrorCliChannel: mirrorCliChannelMock,
  storeDefaultCliChannel: storeDefaultCliChannelMock,
}));

function makeInstalledPackage() {
  return {
    packageId: "pkg-chat",
    enabled: true,
    manifest: {
      name: "chat",
      description: "Chat",
      version: "1.0.0",
      runtime: "web-ui" as const,
      source: {
        repo: "root/gsv",
        ref: "main",
        subdir: "builtin-packages/chat",
        resolvedCommit: "abc123",
      },
      entrypoints: [
        {
          name: "chat",
          kind: "ui" as const,
          description: "Chat app",
          route: "/apps/chat",
          icon: { kind: "builtin", id: "chat" },
          syscalls: ["proc.*"],
          windowDefaults: {
            width: 960,
            height: 720,
            minWidth: 640,
            minHeight: 480,
          },
        },
      ],
    },
  };
}

function makeContext(): KernelContext {
  return {
    env: {
      RIPGIT: {} as Fetcher,
      STORAGE: {} as R2Bucket,
    } as Env,
    identity: {
      role: "user",
      process: {
        uid: 0,
        gid: 0,
        gids: [0],
        username: "root",
        home: "/root",
        cwd: "/root",
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    packages: {
      seedBuiltinPackages: vi.fn(() => [makeInstalledPackage()]),
    } as unknown as KernelContext["packages"],
  } as KernelContext;
}

describe("handleSysBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importFromUpstreamMock.mockResolvedValue({
      remoteUrl: "https://github.com/deathbyknowledge/gsv",
      remoteRef: "main",
      head: "abc123",
      changed: true,
    });
    buildBuiltinPackageSeedsMock.mockResolvedValue([{ name: "chat-seed" }]);
    inferDefaultCliChannelMock.mockReturnValue("dev");
    mirrorCliChannelMock.mockResolvedValue(undefined);
    storeDefaultCliChannelMock.mockResolvedValue(undefined);
  });

  it("bootstraps root/gsv from the default upstream and reseeds builtins", async () => {
    const ctx = makeContext();

    const result = await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      { owner: "root", repo: "gsv", branch: "main" },
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://github.com/deathbyknowledge/gsv#main",
      "https://github.com/deathbyknowledge/gsv",
      "main",
    );
    expect(buildBuiltinPackageSeedsMock).toHaveBeenCalledWith(ctx.env);
    expect(ctx.packages.seedBuiltinPackages).toHaveBeenCalledWith([{ name: "chat-seed" }]);
    expect(inferDefaultCliChannelMock).toHaveBeenCalledWith("main");
    expect(mirrorCliChannelMock).toHaveBeenCalledTimes(2);
    expect(storeDefaultCliChannelMock).toHaveBeenCalledWith(ctx.env.STORAGE, "dev");
    expect(result).toEqual({
      repo: "root/gsv",
      remoteUrl: "https://github.com/deathbyknowledge/gsv",
      ref: "main",
      head: "abc123",
      changed: true,
      cli: {
        defaultChannel: "dev",
        mirroredChannels: ["stable", "dev"],
        assets: ["gsv-darwin-arm64", "gsv-linux-x64"],
      },
      packages: [
        {
          packageId: "pkg-chat",
          name: "chat",
          description: "Chat",
          version: "1.0.0",
          runtime: "web-ui",
          enabled: true,
          source: {
            repo: "root/gsv",
            ref: "main",
            subdir: "builtin-packages/chat",
            resolvedCommit: "abc123",
          },
          entrypoints: [
            {
              name: "chat",
              kind: "ui",
              description: "Chat app",
              route: "/apps/chat",
              command: undefined,
              icon: "chat",
              syscalls: ["proc.*"],
              windowDefaults: {
                width: 960,
                height: 720,
                minWidth: 640,
                minHeight: 480,
              },
            },
          ],
        },
      ],
    });
  });

  it("accepts repo shorthand and custom ref", async () => {
    const ctx = makeContext();

    await handleSysBootstrap({ repo: "example/custom-gsv", ref: "feature/main" }, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://github.com/example/custom-gsv#feature/main",
      "https://github.com/example/custom-gsv",
      "feature/main",
    );
  });

  it("prefers explicit remoteUrl over repo shorthand", async () => {
    const ctx = makeContext();

    await handleSysBootstrap(
      {
        remoteUrl: "https://git.example.com/team/gsv.git",
        repo: "ignored/example",
        ref: "stable",
      },
      ctx,
    );

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://git.example.com/team/gsv.git#stable",
      "https://git.example.com/team/gsv.git",
      "stable",
    );
  });

  it("rejects invalid repo shorthand", async () => {
    const ctx = makeContext();

    await expect(handleSysBootstrap({ repo: "not valid" }, ctx)).rejects.toThrow(
      "Invalid bootstrap repo: not valid",
    );
  });

  it("requires the RIPGIT binding", async () => {
    const ctx = makeContext();
    delete (ctx.env as Partial<Env>).RIPGIT;

    await expect(handleSysBootstrap(undefined, ctx)).rejects.toThrow(
      "RIPGIT binding is required for system bootstrap",
    );
  });
});
