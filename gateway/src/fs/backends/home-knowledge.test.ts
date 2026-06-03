import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import { packageAgentAccessGroup } from "../../kernel/package-agents";
import { GsvFs } from "../gsv-fs";
import { createHomeKnowledgeBackend } from "./home-knowledge";

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
  return null;
}

const auth = {
  getPasswdByUid,
  getPasswdByUsername(username: string) {
    if (username === ALICE.username) return getPasswdByUid(ALICE.uid);
    if (username === PACKAGE_AGENT.username) return getPasswdByUid(PACKAGE_AGENT.uid);
    return null;
  },
  getPersonalAgentUid() {
    return null;
  },
  getGroupByGid(gid: number) {
    if (gid === ALICE.gid) {
      return {
        name: ALICE.username,
        gid: ALICE.gid,
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
  for (const prefix of ["home/alice", "home/wiki-builder"]) {
    let cursor: string | undefined;
    do {
      const listed = await env.STORAGE.list({ prefix, cursor });
      await Promise.all(listed.objects.map((object) => env.STORAGE.delete(object.key)));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}

function createDelegatingBackend() {
  return createHomeKnowledgeBackend(env.STORAGE, fakeRipgit, ALICE, {
    auth: auth as never,
    ownerUid: ALICE.uid,
    isRoot: false,
  });
}

describe("HomeKnowledgeMountBackend delegated routing", () => {
  beforeEach(async () => {
    await clearHomeStorage();
  });

  it("delegates only target home-knowledge overlay paths", () => {
    const backend = createDelegatingBackend();

    expect(backend?.handles("/home/wiki-builder/context.d/persona.md")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/skills.d/workflow.md")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/profiles.d/default/notes.md")).toBe(true);
    expect(backend?.handles("/home/wiki-builder/knowledge/inbox/item.md")).toBe(true);

    expect(backend?.handles("/home/wiki-builder")).toBe(false);
    expect(backend?.handles("/home/wiki-builder/conversations/default/history")).toBe(false);
    expect(backend?.handles("/home/wiki-builder/notes.txt")).toBe(false);
  });

  it("does not read target R2-backed files through the delegated target identity", async () => {
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
  });
});
