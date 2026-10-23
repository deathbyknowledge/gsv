import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gateway from "./index";

// The public `/git/` proxy is the only internet-reachable door to ripgit
// (ripgit itself is not publicly routable). These tests pin the authorization
// classification at that boundary: unauthenticated callers may only perform an
// explicit allowlist of read operations, internal `hyperspace/*` routes are not
// reachable at all, and every other method/path is a write that requires
// `canWriteRepo`. The Kernel stub below faithfully mirrors the real
// `authorizeGitHttp` contract (public read with no credentials is allowed; a
// write, or a private read, requires authorization) so the proof is about the
// Gateway's own classification of the request, not Kernel internals.

type AuthorizeGitHttpInput = {
  owner: string;
  repo: string;
  write: boolean;
  username?: string;
  credential?: string;
};

type RipgitCall = { method: string; path: string; actor: string | null };

const PUBLIC_REPOS = new Set(["root/gsv-manual"]);
const ACCOUNTS = new Map<string, { credential: string; writes: Set<string> }>([
  // alice owns alice/* repos and can push to them.
  ["alice", { credential: "pw-alice", writes: new Set(["alice/home"]) }],
  // reader is a signed-in account with no write access to the public manual.
  ["reader", { credential: "pw-reader", writes: new Set() }],
]);

let authorizeCalls: AuthorizeGitHttpInput[] = [];
let ripgitCalls: RipgitCall[] = [];
let restoreKernel: (() => void) | undefined;
let restoreRipgit: (() => void) | undefined;

function fakeAuthorizeGitHttp(input: AuthorizeGitHttpInput) {
  authorizeCalls.push(input);
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const username = input.username?.trim() ?? "";
  const credential = input.credential?.trim() ?? "";
  const slug = `${owner}/${repo}`;
  const isPublicRead = !input.write && PUBLIC_REPOS.has(slug);

  if (!owner || !repo) {
    return { ok: false as const, status: 401, message: "Authentication required" };
  }

  if (!username || !credential) {
    if (!isPublicRead) {
      return { ok: false as const, status: 401, message: "Authentication required" };
    }
    return { ok: true as const, username: null, uid: -1, capabilities: [] };
  }

  const account = ACCOUNTS.get(username);
  if (account !== undefined && account.credential === credential) {
    const canWrite = account.writes.has(slug);
    const canRead = canWrite || PUBLIC_REPOS.has(slug);
    if (input.write ? !canWrite : !canRead) {
      return { ok: false as const, status: 403, message: "Forbidden" };
    }
    return { ok: true as const, username, uid: 1000, capabilities: [] };
  }

  if (!isPublicRead) {
    return { ok: false as const, status: 401, message: "Authentication failed" };
  }
  return { ok: true as const, username: null, uid: -1, capabilities: [] };
}

beforeEach(() => {
  authorizeCalls = [];
  ripgitCalls = [];

  const ensureInstallationIdentity = vi.fn(async () => {});
  const authorizeGitHttp = vi.fn(async (input: AuthorizeGitHttpInput) =>
    fakeAuthorizeGitHttp(input),
  );
  // SAFETY: HTTP git routing only initializes identity and authorizes on this stub.
  const getByName = vi.spyOn(env.KERNEL, "getByName").mockReturnValue({ ensureInstallationIdentity, authorizeGitHttp } as never);
  restoreKernel = () => getByName.mockRestore();

  // ripgit is not bound in the unit-test wrangler config; record what the proxy
  // would forward so we can prove whether a request escaped to the backend.
  const recordingRipgit = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      ripgitCalls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        actor: request.headers.get("x-ripgit-actor-name"),
      });
      return Promise.resolve(new Response("ripgit-reached", { status: 200 }));
    },
  };
  const previous = Object.getOwnPropertyDescriptor(env, "RIPGIT");
  Object.defineProperty(env, "RIPGIT", { configurable: true, value: recordingRipgit });
  restoreRipgit = () => {
    if (previous) Object.defineProperty(env, "RIPGIT", previous);
    else Reflect.deleteProperty(env, "RIPGIT");
  };
});

afterEach(() => {
  restoreKernel?.();
  restoreRipgit?.();
});

function basic(username: string, credential: string) {
  return { authorization: `Basic ${btoa(`${username}:${credential}`)}` };
}

async function gitFetch(
  method: string,
  suffix: string,
  options: { headers?: Record<string, string> } = {},
): Promise<Response> {
  const request = new Request(`http://localhost/git/${suffix}`, {
    method,
    headers: options.headers,
  });
  const response = await gateway.fetch(request, env);
  await response.arrayBuffer();
  return response;
}

describe("public git proxy write authorization", () => {
  describe("unauthenticated writes to a public repo are refused", () => {
    it("does not forward POST hyperspace/apply to ripgit", async () => {
      const response = await gitFetch("POST", "root/gsv-manual/hyperspace/apply");
      expect(ripgitCalls).toEqual([]);
      expect(response.status).toBe(404);
    });

    it("does not forward POST hyperspace/import to ripgit", async () => {
      const response = await gitFetch("POST", "root/gsv-manual/hyperspace/import");
      expect(ripgitCalls).toEqual([]);
      expect(response.status).toBe(404);
    });

    it("does not forward a GET hyperspace read API either", async () => {
      const response = await gitFetch("GET", "root/gsv-manual/hyperspace/refs");
      expect(ripgitCalls).toEqual([]);
      expect(response.status).toBe(404);
    });
  });

  describe("a read-only signed-in account cannot destroy a public repo", () => {
    it("refuses DELETE of the whole repository", async () => {
      const response = await gitFetch("DELETE", "root/gsv-manual", {
        headers: basic("reader", "pw-reader"),
      });
      // DELETE of a repository has no public caller; it is refused outright.
      expect(ripgitCalls).toEqual([]);
      expect(response.status).toBe(404);
    });

    it("refuses PUT admin/set-ref", async () => {
      const response = await gitFetch(
        "PUT",
        "root/gsv-manual/admin/set-ref?name=refs/heads/main&hash=" + "0".repeat(40),
        { headers: basic("reader", "pw-reader") },
      );
      expect(ripgitCalls).toEqual([]);
      expect(response.status).toBe(404);
    });
  });

  describe("unauthenticated public reads keep working", () => {
    it("advertises refs for git-upload-pack", async () => {
      const response = await gitFetch(
        "GET",
        "root/gsv-manual/info/refs?service=git-upload-pack",
      );
      expect(ripgitCalls).toHaveLength(1);
      expect(ripgitCalls[0]).toMatchObject({
        method: "GET",
        path: "/root/gsv-manual/info/refs",
        actor: null,
      });
      expect(response.status).toBe(200);
    });

    it("forwards POST git-upload-pack (clone/fetch)", async () => {
      await gitFetch("POST", "root/gsv-manual/git-upload-pack");
      expect(ripgitCalls).toHaveLength(1);
      expect(ripgitCalls[0]).toMatchObject({
        method: "POST",
        path: "/root/gsv-manual/git-upload-pack",
        actor: null,
      });
    });

    it.each([
      ["refs", "GET"],
      ["file?path=README.md", "GET"],
      ["search?query=ship", "GET"],
      ["stats", "GET"],
      ["log", "GET"],
      [`diff/${"a".repeat(40)}`, "GET"],
      ["compare?base=main&head=dev", "GET"],
      [`commit/${"b".repeat(40)}`, "GET"],
      [`tree/${"c".repeat(40)}`, "GET"],
      [`blob/${"d".repeat(40)}`, "GET"],
    ])("forwards read API %s unauthenticated", async (suffix, method) => {
      await gitFetch(method, `root/gsv-manual/${suffix}`);
      expect(ripgitCalls).toHaveLength(1);
      expect(ripgitCalls[0]?.actor).toBeNull();
    });
  });

  describe("authenticated pushes keep working", () => {
    it("forwards POST git-receive-pack for an account with write access", async () => {
      const response = await gitFetch("POST", "alice/home/git-receive-pack", {
        headers: basic("alice", "pw-alice"),
      });
      expect(response.status).toBe(200);
      expect(ripgitCalls).toHaveLength(1);
      expect(ripgitCalls[0]).toMatchObject({
        method: "POST",
        path: "/alice/home/git-receive-pack",
        actor: "alice",
      });
      expect(authorizeCalls.at(-1)?.write).toBe(true);
    });

    it("advertises receive-pack refs as a write for a writer", async () => {
      await gitFetch("GET", "alice/home/info/refs?service=git-receive-pack", {
        headers: basic("alice", "pw-alice"),
      });
      expect(ripgitCalls).toHaveLength(1);
      expect(ripgitCalls[0]).toMatchObject({
        method: "GET",
        path: "/alice/home/info/refs",
        actor: "alice",
      });
      expect(authorizeCalls.at(-1)?.write).toBe(true);
    });

    it("rejects a receive-pack push from a read-only account", async () => {
      const response = await gitFetch("POST", "root/gsv-manual/git-receive-pack", {
        headers: basic("reader", "pw-reader"),
      });
      expect(ripgitCalls).toEqual([]);
      expect(response.status).toBe(403);
      expect(authorizeCalls.at(-1)?.write).toBe(true);
    });
  });
});
