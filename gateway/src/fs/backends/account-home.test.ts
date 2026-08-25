import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { GsvFs } from "../gsv-fs";
import { createAccountHomeBackend } from "./account-home";
import { provisionR2Directory } from "./r2";

const ALICE: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
};

const PACKAGE_AGENT: ProcessIdentity = {
  uid: 3000,
  gid: 3000,
  gids: [3000],
  username: "wiki-builder",
  home: "/home/wiki-builder",
  cwd: "/home/wiki-builder",
};

const PERSONAL_AGENT: ProcessIdentity = {
  uid: 2000,
  gid: 2000,
  gids: [2000],
  username: "alice-agent",
  home: "/home/alice-agent",
  cwd: "/home/alice-agent",
};

const BOB: ProcessIdentity = {
  uid: 1001,
  gid: 1001,
  gids: [1001],
  username: "bob",
  home: "/home/bob",
  cwd: "/home/bob",
};

const fakeRipgit = {
  fetch: async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("not found", { status: 404 }),
} satisfies Fetcher;

async function clearHomeStorage(): Promise<void> {
  for (const prefix of [
    "home/alice",
    "home/alice-agent",
    "home/wiki-builder",
    "home/bob",
    "home/unregistered",
  ]) {
    let cursor: string | undefined;
    do {
      const listed = await env.STORAGE.list({ prefix, cursor });
      await Promise.all(listed.objects.map((object) => env.STORAGE.delete(object.key)));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}

const VISIBLE_HOME_ACCOUNTS = [ALICE, PERSONAL_AGENT, PACKAGE_AGENT];

function createDelegatingBackend(
  ripgit: Fetcher = fakeRipgit,
  accounts: readonly ProcessIdentity[] = VISIBLE_HOME_ACCOUNTS,
  publicAccounts: readonly ProcessIdentity[] = [...VISIBLE_HOME_ACCOUNTS, BOB],
) {
  return createAccountHomeBackend(env.STORAGE, ripgit, ALICE, {
    listAccounts: async () => accounts,
    listPublicAccounts: async () => publicAccounts,
    resolveAccount: async (username) => (
      accounts.find((account) => account.username === username) ?? null
    ),
    resolvePublicAccount: async (username) => (
      publicAccounts.find((account) => account.username === username) ?? null
    ),
  });
}

function createPersonalAgentBackend() {
  return createAccountHomeBackend(env.STORAGE, fakeRipgit, PERSONAL_AGENT, {
    listAccounts: async () => VISIBLE_HOME_ACCOUNTS,
    listPublicAccounts: async () => [...VISIBLE_HOME_ACCOUNTS, BOB],
    resolveAccount: async (username) => (
      VISIBLE_HOME_ACCOUNTS.find((account) => account.username === username) ?? null
    ),
    resolvePublicAccount: async (username) => (
      [...VISIBLE_HOME_ACCOUNTS, BOB].find((account) => account.username === username) ?? null
    ),
  });
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("AccountHomeMountBackend delegated routing", () => {
  beforeEach(async () => {
    await clearHomeStorage();
    await provisionR2Directory(env.STORAGE, ALICE.home, ALICE, "750");
  });

  it("reserves target home paths for delegated routing", async () => {
    const backend = createDelegatingBackend();

    expect(await backend?.handles("/home/wiki-builder")).toBe(true);
    expect(await backend?.handles("/home/wiki-builder/context.d/persona.md")).toBe(true);
    expect(await backend?.handles("/home/wiki-builder/skills.d/workflow.md")).toBe(true);
    expect(await backend?.handles("/home/wiki-builder/profiles.d/default/notes.md")).toBe(true);
    expect(await backend?.handles("/home/wiki-builder/knowledge/inbox/item.md")).toBe(true);
    expect(await backend?.handles("/home/wiki-builder/conversations/default/history")).toBe(true);
    expect(await backend?.handles("/home/wiki-builder/notes.txt")).toBe(true);
  });

  it("reserves owner home paths for a personal agent", async () => {
    const backend = createPersonalAgentBackend();

    expect(await backend?.handles("/home/alice")).toBe(true);
    expect(await backend?.handles("/home/alice/context.d/persona.md")).toBe(true);
    expect(await backend?.handles("/home/alice/skills.d/workflow.md")).toBe(true);
    expect(await backend?.handles("/home/alice/knowledge/inbox/item.md")).toBe(true);
    expect(await backend?.handles("/home/alice/conversations/default/history")).toBe(true);
    expect(await backend?.handles("/home/wiki-builder/context.d/persona.md")).toBe(true);
  });

  it("presents /home as a virtual directory containing only accessible accounts", async () => {
    await env.STORAGE.put("home/bob/public.txt", "must not leak through the directory", {
      customMetadata: {
        uid: String(BOB.uid),
        gid: String(BOB.gid),
        mode: "644",
      },
    });
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );

    await expect(fs.exists("/home")).resolves.toBe(true);
    await expect(fs.stat("/home")).resolves.toMatchObject({
      isDirectory: true,
      mode: 0o755,
    });
    await expect(fs.readdir("/home")).resolves.toEqual([
      "alice",
      "alice-agent",
      "wiki-builder",
    ]);
    await expect(fs.readdirWithFileTypes("/home")).resolves.toEqual([
      expect.objectContaining({ name: "alice", isDirectory: true }),
      expect.objectContaining({ name: "alice-agent", isDirectory: true }),
      expect.objectContaining({ name: "wiki-builder", isDirectory: true }),
    ]);
    await expect(fs.readFile("/home")).rejects.toThrow("EISDIR");
    await expect(fs.writeFile("/home", "attack")).rejects.toThrow("EACCES");
  });

  it("searches only accessible account homes through the virtual directory", async () => {
    const searchedOwners: string[] = [];
    const ripgit = {
      async fetch(input: RequestInfo | URL) {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const owner = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        searchedOwners.push(owner);
        return Response.json({
          ok: true,
          matches: [{ path: "context.d/note.md", line: 1, content: `${owner} visible` }],
        });
      },
    } satisfies Fetcher;
    await env.STORAGE.put("home/bob/context.d/secret.md", "bob must stay hidden", {
      customMetadata: {
        uid: String(BOB.uid),
        gid: String(BOB.gid),
        mode: "644",
      },
    });
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(ripgit),
    );

    await expect(fs.search("/home", "visible")).resolves.toEqual({
      matches: [
        { path: "/home/alice/context.d/note.md", line: 1, content: "alice visible" },
        { path: "/home/alice-agent/context.d/note.md", line: 1, content: "alice-agent visible" },
        { path: "/home/wiki-builder/context.d/note.md", line: 1, content: "wiki-builder visible" },
      ],
    });
    expect(searchedOwners).toEqual(["alice", "alice-agent", "wiki-builder"]);
  });

  it("caps aggregate /home searches across accessible accounts", async () => {
    const searchedOwners: string[] = [];
    const ripgit = {
      async fetch(input: RequestInfo | URL) {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const owner = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        searchedOwners.push(owner);
        return Response.json({
          ok: true,
          matches: Array.from({ length: 500 }, (_, index) => ({
            path: `context.d/${index}.md`,
            line: 1,
            content: `${owner}-${index}`,
          })),
        });
      },
    } satisfies Fetcher;
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(ripgit),
    );

    const result = await fs.search("/home", "visible");
    expect(result.matches).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(searchedOwners).toEqual(["alice"]);

    const controller = new AbortController();
    controller.abort();
    await expect(fs.search("/home", "visible", undefined, controller.signal))
      .rejects
      .toThrow();
  });

  it("preserves truncation reported by a single home repository", async () => {
    const ripgit = {
      async fetch() {
        return Response.json({
          ok: true,
          matches: [{ path: "context.d/note.md", line: 1, content: "visible" }],
          truncated: true,
        });
      },
    } satisfies Fetcher;
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(ripgit),
    );

    await expect(fs.search("/home/alice", "visible")).resolves.toEqual({
      matches: [{ path: "/home/alice/context.d/note.md", line: 1, content: "visible" }],
      truncated: true,
    });
  });

  it("forwards Unix metadata operations for R2-backed home paths", async () => {
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );

    await fs.chmod(ALICE.home, 0o755);
    await expect(env.STORAGE.head("home/alice/.dir")).resolves.toMatchObject({
      customMetadata: expect.objectContaining({ mode: "755" }),
    });
    await expect(fs.chmod("/home/alice/context.d", 0o700))
      .rejects
      .toThrow("ENOSYS");
  });

  it("appends overlay files without UTF-8 conversion", async () => {
    const initial = new Uint8Array([0xff, 0x00, 0x80]);
    let applied: number[] = [];
    const ripgit = {
      async fetch(_input: RequestInfo | URL, init?: RequestInit) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { ops: Array<{ contentBytes: number[] }> };
          applied = body.ops[0].contentBytes;
          return Response.json({ ok: true, head: "test" });
        }
        return new Response(initial.slice(), {
          headers: { "X-Blob-Size": String(initial.byteLength) },
        });
      },
    } satisfies Fetcher;
    const backend = createAccountHomeBackend(env.STORAGE, ripgit, ALICE);

    await backend?.appendFile(
      "/home/alice/context.d/binary.dat",
      new Uint8Array([0xfe, 0x61]),
    );

    expect(new Uint8Array(applied)).toEqual(new Uint8Array([0xff, 0x00, 0x80, 0xfe, 0x61]));
  });

  it("streams normal home files through R2", async () => {
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );
    const bytes = new TextEncoder().encode("streamed home data");

    const written = await fs.writeFileStream(
      "/home/alice/archive.bin",
      bytesToStream(bytes),
      {
        expectedSize: bytes.byteLength,
        contentType: "application/x-test",
      },
    );
    const opened = await fs.openFile("/home/alice/archive.bin", {
      range: { offset: 2, length: 4 },
    });

    expect(written).toEqual({ size: bytes.byteLength, streamed: true });
    expect(opened).toMatchObject({
      status: 206,
      size: 4,
      totalSize: bytes.byteLength,
      contentType: "application/x-test",
    });
    expect(new Uint8Array(await new Response(opened.body).arrayBuffer()))
      .toEqual(bytes.subarray(2, 6));
  });

  it("lists virtual overlay roots from an authorized agent home", async () => {
    await env.STORAGE.put("home/wiki-builder/conversations/.dir", "", {
      customMetadata: {
        uid: String(PACKAGE_AGENT.uid),
        gid: String(PACKAGE_AGENT.gid),
        mode: "750",
        dirmarker: "1",
      },
    });

    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );

    await expect(fs.readdir("/home/wiki-builder")).resolves.toEqual([
      "context.d",
      "skills.d",
    ]);
  });

  it("denies delegated reads, lists, searches, and writes for target R2-backed files", async () => {
    await env.STORAGE.put("home/wiki-builder/conversations/default/history", "secret transcript", {
      customMetadata: {
        uid: String(PACKAGE_AGENT.uid),
        gid: String(PACKAGE_AGENT.gid),
        mode: "600",
      },
    });

    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );

    await expect(fs.readFile("/home/wiki-builder/conversations/default/history"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.readdir("/home/wiki-builder/conversations/default"))
      .rejects
      .toThrow("EACCES");
    await expect(createDelegatingBackend()?.readdir("/home/wiki-builder/conversations/default"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.search("/home/wiki-builder/conversations", "secret"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.writeFile("/home/wiki-builder/conversations/default/history", "changed"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.openFile("/home/wiki-builder/conversations/default/history"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.writeFileStream(
      "/home/wiki-builder/conversations/default/history",
      bytesToStream(new Uint8Array([1])),
      { expectedSize: 1 },
    ))
      .rejects
      .toThrow("EACCES");
  });

  it("denies unauthorized account-home paths instead of falling through to R2", async () => {
    await provisionR2Directory(env.STORAGE, BOB.home, BOB, "750");
    await env.STORAGE.put("home/bob/public.txt", "bob public data", {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: {
        uid: String(BOB.uid),
        gid: String(BOB.gid),
        mode: "644",
      },
    });

    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );

    await expect(fs.readFile("/home/bob/public.txt"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.readdir("/home/bob"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.search("/home/bob", "public"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.writeFile("/home/bob/public.txt", "changed"))
      .rejects
      .toThrow("EACCES");
  });

  it("never routes an unknown account name into raw R2", async () => {
    await provisionR2Directory(
      env.STORAGE,
      "/home/unregistered",
      { uid: 4000, gid: 4000 },
      "755",
    );
    await env.STORAGE.put("home/unregistered/public.txt", "raw object", {
      customMetadata: { uid: "4000", gid: "4000", mode: "644" },
    });
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );

    await expect(fs.readFile("/home/unregistered/public.txt"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.readdir("/home")).resolves.not.toContain("unregistered");
  });

  it("lists and reads ordinary cross-home R2 files when Unix modes allow it", async () => {
    await provisionR2Directory(env.STORAGE, BOB.home, BOB, "755");
    await env.STORAGE.put("home/bob/public.txt", "bob shared data", {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: {
        uid: String(BOB.uid),
        gid: String(BOB.gid),
        mode: "644",
      },
    });
    await env.STORAGE.put("home/bob/context.d/private.md", "overlay must not leak", {
      customMetadata: {
        uid: String(BOB.uid),
        gid: String(BOB.gid),
        mode: "644",
      },
    });
    await provisionR2Directory(env.STORAGE, "/home/bob/private", BOB, "700");
    await env.STORAGE.put("home/bob/private/secret.txt", "private must not leak", {
      customMetadata: {
        uid: String(BOB.uid),
        gid: String(BOB.gid),
        mode: "644",
      },
    });
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      createDelegatingBackend(),
    );

    await expect(fs.readdir("/home")).resolves.toContain("bob");
    await expect(fs.readdir("/home/bob")).resolves.toEqual(["private", "public.txt"]);
    await expect(fs.readFile("/home/bob/public.txt")).resolves.toBe("bob shared data");
    await expect(fs.search("/home/bob", "bob shared")).resolves.toEqual({
      matches: [{ path: "/home/bob/public.txt", line: 1, content: "bob shared data" }],
    });
    await expect(fs.search("/home/bob", "must not leak")).resolves.toEqual({
      matches: [],
    });
    await expect(fs.writeFile("/home/bob/public.txt", "changed"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.readFile("/home/bob/context.d/private.md"))
      .rejects
      .toThrow("EACCES");
  });
});
