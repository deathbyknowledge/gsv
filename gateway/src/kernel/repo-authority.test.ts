import { describe, expect, it, vi } from "vitest";
import type { ConnectionIdentity } from "@humansandmachines/gsv/protocol";
import { dispatch, type DispatchDeps } from "./dispatch";
import { Kernel } from "./do";
import type { KernelContext } from "./context";

const KERNEL_CAPABILITY = "a".repeat(64);
const ALICE_IDENTITY: ConnectionIdentity = {
  role: "user",
  process: {
    uid: 1000,
    gid: 1000,
    gids: [1000],
    username: "alice",
    home: "/home/alice",
    cwd: "/home/alice",
  },
  capabilities: [
    "repo.list",
    "repo.refs",
    "repo.read",
    "repo.search",
    "repo.log",
    "repo.diff",
    "repo.compare",
    "repo.create",
    "repo.apply",
    "repo.import",
    "repo.delete",
  ],
};

function makeConfig(seed: Record<string, string>) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => values.set(key, value),
    delete: (key: string) => values.delete(key),
    list: (prefix: string) => {
      const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
      return [...values.entries()]
        .filter(([key]) => key.startsWith(normalized))
        .map(([key, value]) => ({ key, value }));
    },
  };
}

function makeRepoContext(input: {
  config?: ReturnType<typeof makeConfig>;
  packages?: Array<Record<string, unknown>>;
  ripgit?: Fetcher;
} = {}): KernelContext {
  const config = input.config ?? makeConfig({});
  const packages = input.packages ?? [];
  return {
    env: { RIPGIT: input.ripgit } as Env,
    kernelName: "singleton",
    kernelKind: "master",
    auth: {
      getPasswdByUid: (uid: number) => uid === 1000
        ? { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" }
        : null,
      getPasswdByUsername: () => null,
      resolveGids: () => [1000],
    },
    config,
    packages: { list: () => packages },
    identity: ALICE_IDENTITY,
    callerOwnerUid: 1000,
    mutateRepoMetadata: vi.fn(async () => ({ changed: false })),
  } as unknown as KernelContext;
}

function makeMaster(
  context: KernelContext,
  options: {
    authorize?: (proof: { generation: number; kernelCapability: string }) => boolean;
    identity?: () => ConnectionIdentity | null;
  } = {},
) {
  const placement = {
    username: "alice",
    uid: 1000,
    lifecycle: "active",
    generation: 4,
  };
  const kernel = Object.create(Kernel.prototype) as any;
  Object.defineProperty(kernel, "name", { value: "singleton" });
  kernel.authorizeUserKernelCapability = vi.fn(async (proof) => (
    (options.authorize?.(proof)
      ?? (proof.generation === 4 && proof.kernelCapability === KERNEL_CAPABILITY))
      ? placement
      : null
  ));
  kernel.resolveMasterSyscallIdentity = vi.fn(
    options.identity ?? (() => ALICE_IDENTITY),
  );
  kernel.buildKernelContext = vi.fn((build: {
    identity: ConnectionIdentity;
    callerOwnerUid: number;
  }) => ({
    ...context,
    identity: build.identity,
    callerOwnerUid: build.callerOwnerUid,
  }));
  return kernel;
}

function repoAuthorizationInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceKernelName: "user:alice",
    callerOwnerUid: 1000,
    generation: 4,
    kernelCapability: KERNEL_CAPABILITY,
    identity: ALICE_IDENTITY,
    call: "repo.read",
    repo: "bob/notes",
    ...overrides,
  };
}

function authorizeThroughMaster(
  kernel: any,
  identity: ConnectionIdentity = ALICE_IDENTITY,
) {
  return async (
    call: string,
    repo?: string,
    requestedOwner?: string,
  ) => {
    const authorization = await kernel.authorizeUserRepoOperation(
      repoAuthorizationInput({
        identity,
        call,
        ...(repo !== undefined ? { repo } : { repo: undefined }),
        ...(requestedOwner !== undefined ? { requestedOwner } : {}),
      }),
    );
    if (!authorization.ok) throw new Error(authorization.error.message);
    return authorization.repoList;
  };
}

function makeUserContext(input: {
  ripgit: Fetcher;
  authorizeRepoOperation: KernelContext["authorizeRepoOperation"];
  config?: ReturnType<typeof makeConfig>;
  packages?: Array<Record<string, unknown>>;
  identity?: ConnectionIdentity;
  auth?: Record<string, unknown>;
  callerOwnerUid?: number;
}): KernelContext {
  return {
    ...makeRepoContext({
      config: input.config,
      packages: input.packages,
      ripgit: input.ripgit,
    }),
    kernelName: "user:alice",
    kernelKind: "user",
    identity: input.identity ?? ALICE_IDENTITY,
    ...(input.auth ? { auth: input.auth } : {}),
    callerOwnerUid: input.callerOwnerUid ?? 1000,
    authorizeRepoOperation: input.authorizeRepoOperation,
  } as unknown as KernelContext;
}

describe("authoritative user-Kernel repository operations", () => {
  it("keeps RIPGIT payloads local and drops a file before materializing it after privatization", async () => {
    const masterConfig = makeConfig({ "repos/bob/notes/visibility": "public" });
    const masterRipgit = { fetch: vi.fn() } as unknown as Fetcher;
    const kernel = makeMaster(makeRepoContext({ config: masterConfig, ripgit: masterRipgit }));
    const authorizeRepoOperation = vi.fn(authorizeThroughMaster(kernel));
    let finishRead!: (response: Response) => void;
    const localRipgit = {
      fetch: vi.fn(() => new Promise<Response>((resolve) => {
        finishRead = resolve;
      })),
    } as unknown as Fetcher;
    const context = makeUserContext({
      ripgit: localRipgit,
      authorizeRepoOperation,
      config: makeConfig({ "repos/bob/notes/visibility": "public" }),
    });

    const pending = dispatch({
      type: "req",
      id: "repo-read-1",
      call: "repo.read",
      args: { repo: "bob/notes", path: "secret.txt" },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);
    await vi.waitFor(() => expect(localRipgit.fetch).toHaveBeenCalledOnce());
    masterConfig.delete("repos/bob/notes/visibility");
    const ripgitResponse = new Response("absolute secret\n", {
      headers: { "content-type": "text/plain" },
    });
    const materialize = vi.spyOn(ripgitResponse, "arrayBuffer");
    finishRead(ripgitResponse);

    const result = await pending;
    expect(result).toMatchObject({
      handled: true,
      response: { ok: false, error: { message: "Repository operation is not authorized" } },
    });
    expect(JSON.stringify(result)).not.toContain("absolute secret");
    expect(materialize).not.toHaveBeenCalled();
    expect(authorizeRepoOperation).toHaveBeenCalledTimes(2);
    expect(masterRipgit.fetch).not.toHaveBeenCalled();
  });

  it("drops package source data when access is revoked before the post-fetch decision", async () => {
    const packages: Array<Record<string, unknown>> = [{
      packageId: "wiki",
      scope: { kind: "user", uid: 1000 },
      manifest: { name: "Wiki", source: { repo: "root/gsv" } },
    }];
    const kernel = makeMaster(makeRepoContext({ packages }));
    const authorizeRepoOperation = vi.fn(authorizeThroughMaster(kernel));
    let finishRead!: (response: Response) => void;
    const localRipgit = {
      fetch: vi.fn(() => new Promise<Response>((resolve) => {
        finishRead = resolve;
      })),
    } as unknown as Fetcher;
    const context = makeUserContext({
      ripgit: localRipgit,
      authorizeRepoOperation,
      packages: [...packages],
    });

    const pending = dispatch({
      type: "req",
      id: "package-read-1",
      call: "repo.read",
      args: { repo: "root/gsv", path: "packages/wiki/README.md" },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);
    await vi.waitFor(() => expect(localRipgit.fetch).toHaveBeenCalledOnce());
    packages.splice(0, packages.length);
    const ripgitResponse = new Response("private package source\n", {
      headers: { "content-type": "text/plain" },
    });
    const materialize = vi.spyOn(ripgitResponse, "arrayBuffer");
    finishRead(ripgitResponse);

    const result = await pending;
    expect(result).toMatchObject({ handled: true, response: { ok: false } });
    expect(JSON.stringify(result)).not.toContain("private package source");
    expect(materialize).not.toHaveBeenCalled();
    expect(authorizeRepoOperation).toHaveBeenCalledTimes(2);
  });

  it("rejects tampered and stale-generation capability replays without touching RIPGIT", async () => {
    let activeGeneration = 4;
    const masterRipgit = { fetch: vi.fn() } as unknown as Fetcher;
    const kernel = makeMaster(
      makeRepoContext({
        config: makeConfig({ "repos/bob/notes/visibility": "public" }),
        ripgit: masterRipgit,
      }),
      {
        authorize: (proof) => proof.generation === activeGeneration
          && proof.kernelCapability === KERNEL_CAPABILITY,
      },
    );

    await expect(kernel.authorizeUserRepoOperation(repoAuthorizationInput({
      kernelCapability: "f".repeat(64),
    }))).resolves.toMatchObject({ ok: false, error: { code: 401 } });
    activeGeneration = 5;
    await expect(kernel.authorizeUserRepoOperation(repoAuthorizationInput()))
      .resolves.toMatchObject({ ok: false, error: { code: 401 } });
    expect(masterRipgit.fetch).not.toHaveBeenCalled();
  });

  it("drops an in-flight response when the user Kernel lifecycle changes", async () => {
    let capabilityChecks = 0;
    const kernel = makeMaster(
      makeRepoContext({
        config: makeConfig({ "repos/bob/notes/visibility": "public" }),
      }),
      { authorize: () => ++capabilityChecks === 1 },
    );
    const authorizeRepoOperation = vi.fn(authorizeThroughMaster(kernel));
    let finishRead!: (response: Response) => void;
    const localRipgit = {
      fetch: vi.fn(() => new Promise<Response>((resolve) => {
        finishRead = resolve;
      })),
    } as unknown as Fetcher;
    const context = makeUserContext({
      ripgit: localRipgit,
      authorizeRepoOperation,
      config: makeConfig({ "repos/bob/notes/visibility": "public" }),
    });

    const pending = dispatch({
      type: "req",
      id: "lifecycle-read-1",
      call: "repo.read",
      args: { repo: "bob/notes", path: "secret.txt" },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);
    await vi.waitFor(() => expect(localRipgit.fetch).toHaveBeenCalledOnce());
    const ripgitResponse = new Response("discard after suspension\n");
    const materialize = vi.spyOn(ripgitResponse, "arrayBuffer");
    finishRead(ripgitResponse);

    const result = await pending;
    expect(result).toMatchObject({ handled: true, response: { ok: false } });
    expect(materialize).not.toHaveBeenCalled();
    expect(capabilityChecks).toBe(2);
  });

  it("builds repo.list from current Master metadata instead of a stale projection", async () => {
    const kernel = makeMaster(makeRepoContext({ config: makeConfig({}) }));
    const authorizeRepoOperation = vi.fn(authorizeThroughMaster(kernel));
    const context = makeUserContext({
      ripgit: { fetch: vi.fn() } as unknown as Fetcher,
      authorizeRepoOperation,
      config: makeConfig({
        "repos/bob/notes/created_at": "1",
        "repos/bob/notes/visibility": "public",
        "repos/bob/notes/description": "sensitive description",
      }),
    });

    const result = await dispatch({
      type: "req",
      id: "repo-list-1",
      call: "repo.list",
      args: {},
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);

    expect(result).toMatchObject({
      response: {
        ok: true,
        data: { repos: [expect.objectContaining({ repo: "alice/home" })] },
      },
    });
    expect(JSON.stringify(result)).not.toContain("bob/notes");
    expect(JSON.stringify(result)).not.toContain("sensitive description");
  });

  it("never sends tool arguments or repository content into the Master decision", async () => {
    const authorizeRepoOperation = vi.fn(async () => undefined);
    const localRipgit = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/search")) {
          return Response.json({ ok: true, matches: [], truncated: false });
        }
        if (url.pathname.endsWith("/import")) {
          return Response.json({
            ok: true,
            head: "abc123",
            changed: true,
            remote_url: "https://example.invalid/redacted.git",
            remote_ref: "main",
          });
        }
        if (url.pathname.endsWith("/apply")) {
          return Response.json({ ok: true, head: "abc123" });
        }
        return new Response("local-only contents");
      }),
    } as unknown as Fetcher;
    const context = makeUserContext({ ripgit: localRipgit, authorizeRepoOperation });
    const fileSecret = "do-not-cross-the-control-plane";
    const privatePath = "secrets/account-recovery.txt";
    const privateQuery = "recovery phrase";
    const credentialedRemote = "https://user:password@example.invalid/private.git";

    const applyResult = await dispatch({
      type: "req",
      id: "repo-apply-1",
      call: "repo.apply",
      args: {
        repo: " alice/demo ",
        ref: "main",
        message: `private commit ${fileSecret}`,
        ops: [{ type: "put", path: "secret.txt", content: fileSecret }],
      },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);
    const readResult = await dispatch({
      type: "req",
      id: "repo-read-sensitive-1",
      call: "repo.read",
      args: { repo: "alice/demo", path: privatePath },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);
    const searchResult = await dispatch({
      type: "req",
      id: "repo-search-sensitive-1",
      call: "repo.search",
      args: { repo: "alice/demo", query: privateQuery },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);
    const importResult = await dispatch({
      type: "req",
      id: "repo-import-sensitive-1",
      call: "repo.import",
      args: {
        repo: "alice/demo",
        ref: "main",
        remoteUrl: credentialedRemote,
        message: `import ${fileSecret}`,
      },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);

    for (const result of [applyResult, readResult, searchResult, importResult]) {
      expect(result).toMatchObject({ response: { ok: true } });
    }
    expect(authorizeRepoOperation.mock.calls).toEqual([
      ["repo.apply", "alice/demo"],
      ["repo.read", "alice/demo"],
      ["repo.read", "alice/demo"],
      ["repo.search", "alice/demo"],
      ["repo.search", "alice/demo"],
      ["repo.import", "alice/demo"],
    ]);
    const masterInputs = JSON.stringify(authorizeRepoOperation.mock.calls);
    for (const sensitive of [
      fileSecret,
      "private commit",
      privatePath,
      privateQuery,
      credentialedRemote,
    ]) {
      expect(masterInputs).not.toContain(sensitive);
    }
  });

  it("denies a revoked package-agent write before any RIPGIT mutation", async () => {
    const agentIdentity: ConnectionIdentity = {
      role: "user",
      process: {
        uid: 2000,
        gid: 2000,
        gids: [2000],
        username: "wiki-agent",
        home: "/home/wiki-agent",
        cwd: "/home/wiki-agent",
      },
      capabilities: ["repo.apply"],
    };
    const masterContext = makeRepoContext();
    masterContext.auth = {
      getPasswdByUid: (uid: number) => uid === 1000
        ? { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" }
        : uid === 2000
          ? agentIdentity.process
          : null,
      getPersonalAgentUid: () => null,
      getGroupByGid: () => null,
      getGroupByName: () => ({ gid: 3000, name: "revoked-access", members: [] }),
    } as unknown as KernelContext["auth"];
    const kernel = makeMaster(masterContext, { identity: () => agentIdentity });
    const authorizeRepoOperation = vi.fn(authorizeThroughMaster(kernel, agentIdentity));
    const localRipgit = { fetch: vi.fn() } as unknown as Fetcher;
    const context = makeUserContext({
      ripgit: localRipgit,
      authorizeRepoOperation,
      identity: agentIdentity,
      callerOwnerUid: 1000,
      auth: {
        getPasswdByUid: (uid: number) => uid === 1000
          ? { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" }
          : null,
        getPersonalAgentUid: () => null,
        getGroupByGid: () => null,
        getGroupByName: () => ({ gid: 3000, name: "stale-access", members: ["alice"] }),
      },
    });

    const result = await dispatch({
      type: "req",
      id: "revoked-agent-write-1",
      call: "repo.apply",
      args: {
        repo: "alice/home",
        ref: "main",
        message: "stale write",
        ops: [{ type: "put", path: "stale.txt", content: "must not land" }],
      },
    }, { type: "process", id: "proc-1" }, context, {} as DispatchDeps);

    expect(result).toMatchObject({ handled: true, response: { ok: false } });
    expect(localRipgit.fetch).not.toHaveBeenCalled();
    expect(authorizeRepoOperation).toHaveBeenCalledWith("repo.apply", "alice/home");
  });
});
