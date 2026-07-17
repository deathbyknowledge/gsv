import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { packageAgentAccessGroup } from "../../kernel/package-agents";
import { GsvFs } from "../gsv-fs";
import { createAccountHomeBackend } from "./account-home";

const ROOT: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

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

function getPasswdByUid(uid: number) {
  if (uid === ALICE.uid) {
    return {
      username: ALICE.username,
      uid: ALICE.uid,
      gid: ALICE.gid,
      gecos: ALICE.username,
      home: ALICE.home,
      shell: "/bin/init",
    };
  }
  if (uid === PERSONAL_AGENT.uid) {
    return {
      username: PERSONAL_AGENT.username,
      uid: PERSONAL_AGENT.uid,
      gid: PERSONAL_AGENT.gid,
      gecos: PERSONAL_AGENT.username,
      home: PERSONAL_AGENT.home,
      shell: "/bin/init",
    };
  }
  if (uid === PACKAGE_AGENT.uid) {
    return {
      username: PACKAGE_AGENT.username,
      uid: PACKAGE_AGENT.uid,
      gid: PACKAGE_AGENT.gid,
      gecos: PACKAGE_AGENT.username,
      home: PACKAGE_AGENT.home,
      shell: "/bin/init",
    };
  }
  if (uid === BOB.uid) {
    return {
      username: BOB.username,
      uid: BOB.uid,
      gid: BOB.gid,
      gecos: BOB.username,
      home: BOB.home,
      shell: "/bin/init",
    };
  }
  return null;
}

const auth = {
  getPasswdEntries() {
    return [ALICE, PERSONAL_AGENT, PACKAGE_AGENT, BOB]
      .map((identity) => getPasswdByUid(identity.uid)!);
  },
  getPasswdByUid,
  getPasswdByUsername(username: string) {
    if (username === ALICE.username) return getPasswdByUid(ALICE.uid);
    if (username === PERSONAL_AGENT.username) return getPasswdByUid(PERSONAL_AGENT.uid);
    if (username === PACKAGE_AGENT.username) return getPasswdByUid(PACKAGE_AGENT.uid);
    if (username === BOB.username) return getPasswdByUid(BOB.uid);
    return null;
  },
  getPersonalAgentUid(ownerUid: number) {
    return ownerUid === ALICE.uid ? PERSONAL_AGENT.uid : null;
  },
  getGroupByGid(gid: number) {
    if (gid === ALICE.gid) {
      return {
        name: ALICE.username,
        gid: ALICE.gid,
        members: [],
      };
    }
    if (gid === PERSONAL_AGENT.gid) {
      return {
        name: PERSONAL_AGENT.username,
        gid: PERSONAL_AGENT.gid,
        members: [],
      };
    }
    if (gid === PACKAGE_AGENT.gid) {
      return {
        name: PACKAGE_AGENT.username,
        gid: PACKAGE_AGENT.gid,
        members: [],
      };
    }
    if (gid === BOB.gid) {
      return {
        name: BOB.username,
        gid: BOB.gid,
        members: [],
      };
    }
    return null;
  },
  getGroupByName(name: string) {
    if (name === packageAgentAccessGroup(PACKAGE_AGENT.username)) {
      return { name, gid: 3001, members: [ALICE.username] };
    }
    return null;
  },
  resolveGids(username: string, primaryGid: number) {
    return username === ALICE.username ? ALICE.gids : [primaryGid];
  },
};

async function clearHomeStorage(): Promise<void> {
  for (const prefix of ["home/alice", "home/alice-agent", "home/wiki-builder", "home/bob"]) {
    let cursor: string | undefined;
    do {
      const listed = await env.STORAGE.list({ prefix, cursor });
      await Promise.all(listed.objects.map((object) => env.STORAGE.delete(object.key)));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}

function createDelegatingBackend() {
  return createAccountHomeBackend(env.STORAGE, fakeRipgit, ALICE, {
    auth: auth as never,
    ownerUid: ALICE.uid,
    isRoot: false,
  });
}

function createPersonalAgentBackend() {
  return createAccountHomeBackend(env.STORAGE, fakeRipgit, PERSONAL_AGENT, {
    auth: auth as never,
    ownerUid: ALICE.uid,
    isRoot: false,
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
  });

  it("reserves target home paths for delegated routing", () => {
    const backend = createDelegatingBackend();

    expect(backend?.handles("/home/wiki-builder")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/context.d/persona.md")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/skills.d/workflow.md")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/profiles.d/default/notes.md")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/knowledge/inbox/item.md")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/conversations/default/history")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/notes.txt")).toBe(true);
  });

  it("reserves owner home paths for a personal agent", () => {
    const backend = createPersonalAgentBackend();

    expect(backend?.handles("/home/alice")).toBe(true);
    expect(backend?.handles("/home/alice/context.d/persona.md")).toBe(true);
    expect(backend?.handles("/home/alice/skills.d/workflow.md")).toBe(true);
    expect(backend?.handles("/home/alice/knowledge/inbox/item.md")).toBe(true);
    expect(backend?.handles("/home/alice/conversations/default/history")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/context.d/persona.md")).toBe(true);
  });

  it("resolves authorized ripgit homes through a virtual /home on empty R2", async () => {
    const reads: string[] = [];
    const ripgit = {
      async fetch(input: RequestInfo | URL) {
        const url = new URL(String(input));
        const path = url.searchParams.get("path") ?? "";
        reads.push(`${url.pathname}:${path}`);
        if (path === "skills.d") {
          return Response.json([{
            name: "workflow.md",
            mode: "100644",
            hash: "skill-hash",
            type: "blob",
          }]);
        }
        return new Response("not found", { status: 404 });
      },
    } satisfies Fetcher;
    const backend = createAccountHomeBackend(env.STORAGE, ripgit, ALICE, {
      auth: auth as never,
      ownerUid: ALICE.uid,
      isRoot: false,
    });
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      backend,
    );

    await expect(env.STORAGE.list({ prefix: "home/" }))
      .resolves
      .toMatchObject({ objects: [] });
    await expect(fs.statExtended("/home")).resolves.toMatchObject({
      isDirectory: true,
      mode: 0o755,
      uid: 0,
      gid: 0,
    });
    await expect(fs.readdir("/home")).resolves.toEqual([
      "alice",
      "alice-agent",
      "wiki-builder",
    ]);
    await expect(fs.readdir("/home/alice/skills.d")).resolves.toEqual(["workflow.md"]);
    await expect(fs.readdir("/home/wiki-builder/skills.d")).resolves.toEqual(["workflow.md"]);
    expect(reads).toEqual(expect.arrayContaining([
      "/hyperspace/repos/alice/home/read:skills.d",
      "/hyperspace/repos/wiki-builder/home/read:skills.d",
    ]));
  });

  it("does not reveal unauthorized R2 home roots through the virtual namespace", async () => {
    await env.STORAGE.put("home/bob/private.txt", "secret", {
      customMetadata: {
        uid: String(BOB.uid),
        gid: String(BOB.gid),
        mode: "644",
      },
    });
    const backend = createDelegatingBackend();
    const fs = new GsvFs(
      env.STORAGE,
      ALICE,
      undefined,
      undefined,
      null,
      backend,
    );

    await expect(fs.readdir("/home")).resolves.toEqual([
      "alice",
      "alice-agent",
      "wiki-builder",
    ]);
    await expect(fs.stat("/home/bob")).rejects.toThrow("EACCES");
    await expect(fs.readdir("/home/bob")).rejects.toThrow("EACCES");

    const rootBackend = createAccountHomeBackend(env.STORAGE, fakeRipgit, ROOT, {
      auth: auth as never,
      ownerUid: ROOT.uid,
      isRoot: true,
    });
    const rootFs = new GsvFs(
      env.STORAGE,
      ROOT,
      undefined,
      undefined,
      null,
      rootBackend,
    );
    await expect(rootFs.readdir("/home")).resolves.toEqual([
      "alice",
      "alice-agent",
      "bob",
      "wiki-builder",
    ]);
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

  it("exposes archived media as read-only account-home files", async () => {
    const archiveKey = `home/alice/.gsv/media/archived-media:${"a".repeat(64)}`;
    const archivePath = `/${archiveKey}`;
    const archivedBytes = new Uint8Array([1, 3, 5, 7]);
    await env.STORAGE.put(archiveKey, archivedBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        uid: String(ALICE.uid),
        gid: String(ALICE.gid),
        mode: "400",
        purpose: "conversation-media",
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

    await expect(fs.readFileBuffer(archivePath)).resolves.toEqual(archivedBytes);
    await expect(fs.writeFile(archivePath, "overwrite"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.appendFile(archivePath, "append"))
      .rejects
      .toThrow("EACCES");
    await expect(fs.mkdir(`${archivePath}/nested`, { recursive: true }))
      .rejects
      .toThrow("EACCES");
    await expect(fs.rm(archivePath, { force: true }))
      .rejects
      .toThrow("EACCES");
    await expect(fs.symlink("/home/alice/archive.bin", `${archivePath}.link`))
      .rejects
      .toThrow("EACCES");

    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason;
      },
    }, { highWaterMark: 0 });
    await expect(fs.writeFileStream(archivePath, stream, { expectedSize: 1 }))
      .rejects
      .toThrow("EACCES");
    expect(cancelled).toBeInstanceOf(Error);
    expect((cancelled as Error).message).toContain("EACCES");
    await expect(env.STORAGE.get(archiveKey).then((object) => object?.arrayBuffer()))
      .resolves
      .toEqual(archivedBytes.buffer);
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
});
