import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { GsvFs, parseMode, isValidMode, resolveUserPath } from "./index";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";

const ROOT: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
  workspaceId: null,
};

const SAM: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

const ALICE: ProcessIdentity = {
  uid: 1001,
  gid: 100,
  gids: [100],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
  workspaceId: null,
};

function putFile(
  path: string,
  content: string,
  meta: { uid: string; gid: string; mode: string },
) {
  return env.STORAGE.put(path, content, {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: meta,
  });
}

function makeFs(identity: ProcessIdentity): GsvFs {
  return new GsvFs(env.STORAGE, identity);
}

function makeConfigBackedFs(
  identity: ProcessIdentity,
  initialEntries: Record<string, string>,
): GsvFs {
  const entries = new Map<string, string>(Object.entries(initialEntries));
  const config = {
    get(key: string): string | null {
      return entries.has(key) ? entries.get(key)! : null;
    },
    set(key: string, value: string): void {
      entries.set(key, value);
    },
    list(prefix: string): { key: string; value: string }[] {
      const normalized = prefix.trim();
      const keys = [...entries.keys()].sort();
      if (!normalized) {
        return keys.map((key) => ({ key, value: entries.get(key)! }));
      }
      const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
      return keys
        .filter((key) => key.startsWith(withSlash))
        .map((key) => ({ key, value: entries.get(key)! }));
    },
  };

  return new GsvFs(env.STORAGE, identity, {
    auth: null as never,
    procs: null as never,
    devices: null as never,
    caps: null as never,
    config: config as never,
    workspaces: null as never,
  });
}

describe("parseMode", () => {
  it("parses 644", () => {
    expect(parseMode("644")).toEqual({ owner: 6, group: 4, other: 4 });
  });

  it("parses 755", () => {
    expect(parseMode("755")).toEqual({ owner: 7, group: 5, other: 5 });
  });

  it("parses 600", () => {
    expect(parseMode("600")).toEqual({ owner: 6, group: 0, other: 0 });
  });

  it("parses 640", () => {
    expect(parseMode("640")).toEqual({ owner: 6, group: 4, other: 0 });
  });

  it("pads short strings", () => {
    expect(parseMode("44")).toEqual({ owner: 0, group: 4, other: 4 });
  });

  it("handles 4-digit modes by taking last 3", () => {
    expect(parseMode("0755")).toEqual({ owner: 7, group: 5, other: 5 });
  });
});

describe("isValidMode", () => {
  it("accepts valid 3-digit modes", () => {
    expect(isValidMode("644")).toBe(true);
    expect(isValidMode("755")).toBe(true);
    expect(isValidMode("000")).toBe(true);
    expect(isValidMode("777")).toBe(true);
  });

  it("accepts valid 4-digit modes", () => {
    expect(isValidMode("0644")).toBe(true);
    expect(isValidMode("1755")).toBe(true);
  });

  it("rejects invalid modes", () => {
    expect(isValidMode("89")).toBe(false);
    expect(isValidMode("abc")).toBe(false);
    expect(isValidMode("")).toBe(false);
    expect(isValidMode("12345")).toBe(false);
    expect(isValidMode("888")).toBe(false);
  });
});

describe("GsvFs permissions", () => {
  const TEST_PREFIX = "test/perms/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("root (uid 0) can read any file", async () => {
    await putFile(`${TEST_PREFIX}secret.txt`, "top secret", {
      uid: "1000", gid: "1000", mode: "600",
    });

    const fs = makeFs(ROOT);
    const content = await fs.readFile(`/${TEST_PREFIX}secret.txt`);
    expect(content).toBe("top secret");
  });

  it("owner can read their own 600 file", async () => {
    await putFile(`${TEST_PREFIX}mine.txt`, "my data", {
      uid: "1000", gid: "1000", mode: "600",
    });

    const fs = makeFs(SAM);
    const content = await fs.readFile(`/${TEST_PREFIX}mine.txt`);
    expect(content).toBe("my data");
  });

  it("non-owner is denied reading a 600 file", async () => {
    await putFile(`${TEST_PREFIX}private.txt`, "secret", {
      uid: "1000", gid: "1000", mode: "600",
    });

    const fs = makeFs(ALICE);
    await expect(fs.readFile(`/${TEST_PREFIX}private.txt`)).rejects.toThrow("EACCES");
  });

  it("group member can read a 640 file", async () => {
    await putFile(`${TEST_PREFIX}group-read.txt`, "group data", {
      uid: "1000", gid: "100", mode: "640",
    });

    const fs = makeFs(ALICE);
    const content = await fs.readFile(`/${TEST_PREFIX}group-read.txt`);
    expect(content).toBe("group data");
  });

  it("non-group member is denied reading a 640 file", async () => {
    await putFile(`${TEST_PREFIX}group-only.txt`, "group data", {
      uid: "999", gid: "999", mode: "640",
    });

    const fs = makeFs(SAM);
    await expect(fs.readFile(`/${TEST_PREFIX}group-only.txt`)).rejects.toThrow("EACCES");
  });

  it("anyone can read a 644 file", async () => {
    await putFile(`${TEST_PREFIX}public.txt`, "hello world", {
      uid: "0", gid: "0", mode: "644",
    });

    const fs = makeFs(ALICE);
    const content = await fs.readFile(`/${TEST_PREFIX}public.txt`);
    expect(content).toBe("hello world");
  });

  it("non-owner is denied writing a 644 file", async () => {
    await putFile(`${TEST_PREFIX}readonly.txt`, "original", {
      uid: "0", gid: "0", mode: "644",
    });

    const fs = makeFs(SAM);
    await expect(fs.writeFile(`/${TEST_PREFIX}readonly.txt`, "modified")).rejects.toThrow("EACCES");
  });

  it("owner can write their own 644 file", async () => {
    await putFile(`${TEST_PREFIX}owner-edit.txt`, "original", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(SAM);
    await fs.writeFile(`/${TEST_PREFIX}owner-edit.txt`, "modified");
    const content = await fs.readFile(`/${TEST_PREFIX}owner-edit.txt`);
    expect(content).toBe("modified");
  });

  it("root can write any file", async () => {
    await putFile(`${TEST_PREFIX}root-edit.txt`, "original", {
      uid: "1000", gid: "1000", mode: "600",
    });

    const fs = makeFs(ROOT);
    await fs.writeFile(`/${TEST_PREFIX}root-edit.txt`, "modified");
    const content = await fs.readFile(`/${TEST_PREFIX}root-edit.txt`);
    expect(content).toBe("modified");
  });

  it("root can delete any file", async () => {
    await putFile(`${TEST_PREFIX}root-del.txt`, "bye", {
      uid: "1000", gid: "1000", mode: "600",
    });

    const fs = makeFs(ROOT);
    await fs.rm(`/${TEST_PREFIX}root-del.txt`);
    const exists = await fs.exists(`/${TEST_PREFIX}root-del.txt`);
    expect(exists).toBe(false);
  });

  it("non-owner is denied deleting a file", async () => {
    await putFile(`${TEST_PREFIX}no-del.txt`, "stay", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(ALICE);
    await expect(fs.rm(`/${TEST_PREFIX}no-del.txt`)).rejects.toThrow("EACCES");
  });
});

describe("GsvFs write metadata", () => {
  const TEST_PREFIX = "test/meta/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("write stamps uid, gid, and mode 644 on new files", async () => {
    const fs = makeFs(SAM);
    await fs.writeFile(`/${TEST_PREFIX}new.txt`, "hello");

    const head = await env.STORAGE.head(`${TEST_PREFIX}new.txt`);
    expect(head?.customMetadata?.uid).toBe("1000");
    expect(head?.customMetadata?.gid).toBe("1000");
    expect(head?.customMetadata?.mode).toBe("644");
  });
});

describe("GsvFs chmod", () => {
  const TEST_PREFIX = "test/chmod/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("owner can chmod their file", async () => {
    await putFile(`${TEST_PREFIX}myfile.txt`, "data", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(SAM);
    await fs.chmod(`/${TEST_PREFIX}myfile.txt`, 0o600);

    const head = await env.STORAGE.head(`${TEST_PREFIX}myfile.txt`);
    expect(head?.customMetadata?.mode).toBe("600");
  });

  it("root can chmod any file", async () => {
    await putFile(`${TEST_PREFIX}anyfile.txt`, "data", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(ROOT);
    await fs.chmod(`/${TEST_PREFIX}anyfile.txt`, 0o755);

    const head = await env.STORAGE.head(`${TEST_PREFIX}anyfile.txt`);
    expect(head?.customMetadata?.mode).toBe("755");
  });

  it("non-owner non-root is denied chmod", async () => {
    await putFile(`${TEST_PREFIX}notmine.txt`, "data", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(ALICE);
    await expect(fs.chmod(`/${TEST_PREFIX}notmine.txt`, 0o777)).rejects.toThrow("EPERM");
  });

  it("returns error for nonexistent file", async () => {
    const fs = makeFs(ROOT);
    await expect(fs.chmod(`/${TEST_PREFIX}ghost.txt`, 0o644)).rejects.toThrow("ENOENT");
  });
});

describe("GsvFs chown", () => {
  const TEST_PREFIX = "test/chown/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("root can chown a file", async () => {
    await putFile(`${TEST_PREFIX}transfer.txt`, "data", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(ROOT);
    await fs.chown(`/${TEST_PREFIX}transfer.txt`, 1001, 100);

    const head = await env.STORAGE.head(`${TEST_PREFIX}transfer.txt`);
    expect(head?.customMetadata?.uid).toBe("1001");
    expect(head?.customMetadata?.gid).toBe("100");
  });

  it("non-root is denied chown", async () => {
    await putFile(`${TEST_PREFIX}nochange.txt`, "data", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(SAM);
    await expect(fs.chown(`/${TEST_PREFIX}nochange.txt`, 1001, 100)).rejects.toThrow("EPERM");
  });

  it("returns error for nonexistent file", async () => {
    const fs = makeFs(ROOT);
    await expect(fs.chown(`/${TEST_PREFIX}ghost.txt`, 0, 0)).rejects.toThrow("ENOENT");
  });
});

describe("GsvFs directory removal", () => {
  const TEST_PREFIX = "test/dirs/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("removes an empty directory created via mkdir", async () => {
    const fs = makeFs(ROOT);

    await fs.mkdir(`/${TEST_PREFIX}alpha`, { recursive: true });
    await fs.rm(`/${TEST_PREFIX}alpha`);

    const exists = await fs.exists(`/${TEST_PREFIX}alpha`);
    expect(exists).toBe(false);
  });

  it("refuses removing non-empty directory without recursive option", async () => {
    const fs = makeFs(ROOT);

    await fs.mkdir(`/${TEST_PREFIX}beta`, { recursive: true });
    await fs.writeFile(`/${TEST_PREFIX}beta/file.txt`, "hello");

    await expect(fs.rm(`/${TEST_PREFIX}beta`)).rejects.toThrow("ENOTEMPTY");
  });
});

describe("resolveUserPath", () => {
  it("resolves ~ to home", () => {
    expect(resolveUserPath("~", "/home/sam", "/home/sam")).toBe("/home/sam");
    expect(resolveUserPath("~/docs/file.md", "/home/sam", "/home/sam")).toBe("/home/sam/docs/file.md");
  });

  it("resolves ~ for root to /root", () => {
    expect(resolveUserPath("~", "/root", "/root")).toBe("/root");
    expect(resolveUserPath("~/file.txt", "/root", "/root")).toBe("/root/file.txt");
  });

  it("resolves relative paths against cwd", () => {
    expect(resolveUserPath("file.txt", "/home/sam", "/home/sam")).toBe("/home/sam/file.txt");
  });

  it("resolves .. segments", () => {
    expect(resolveUserPath("/home/sam/docs/../file.txt", "/home/sam", "/home/sam")).toBe("/home/sam/file.txt");
  });

  it("absolute paths are used as-is", () => {
    expect(resolveUserPath("/etc/passwd", "/home/sam", "/home/sam")).toBe("/etc/passwd");
  });

  it("respects custom cwd", () => {
    expect(resolveUserPath("src/main.ts", "/home/sam", "/projects/myapp")).toBe("/projects/myapp/src/main.ts");
  });
});

describe("GsvFs root path", () => {
  it("treats / as an existing directory", async () => {
    const fs = makeFs(ROOT);
    const exists = await fs.exists("/");
    const stat = await fs.stat("/");

    expect(exists).toBe(true);
    expect(stat.isDirectory).toBe(true);
    expect(stat.mode).toBe(0o755);
  });
});

describe("GsvFs virtual /dev", () => {
  it("reads /dev/null as empty string", async () => {
    const fs = makeFs(SAM);
    const content = await fs.readFile("/dev/null");
    expect(content).toBe("");
  });

  it("writes to /dev/null are discarded", async () => {
    const fs = makeFs(SAM);
    await fs.writeFile("/dev/null", "discarded");
  });

  it("reads /dev/zero as null bytes", async () => {
    const fs = makeFs(SAM);
    const content = await fs.readFile("/dev/zero");
    expect(content.length).toBe(256);
  });

  it("reads /dev/random as random data", async () => {
    const fs = makeFs(SAM);
    const buf = await fs.readFileBuffer("/dev/random");
    expect(buf.length).toBe(256);
  });

  it("lists /dev directory", async () => {
    const fs = new GsvFs(env.STORAGE, SAM, {
      procs: null as never,
      devices: null as never,
      caps: null as never,
      config: null as never,
      workspaces: null as never,
    });
    const entries = await fs.readdir("/dev");
    expect(entries).toContain("null");
    expect(entries).toContain("zero");
    expect(entries).toContain("random");
    expect(entries).toContain("urandom");
  });
});

describe("GsvFs virtual /sys config tree", () => {
  it("lists nested /sys/config directories based on config key prefixes", async () => {
    const fs = makeConfigBackedFs(ROOT, {
      "config/ai/provider": "anthropic",
      "config/ai/model": "claude-sonnet-4-20250514",
      "config/ai/api_key": "sk-test",
      "config/server/name": "gsv",
    });

    const top = await fs.readdir("/sys/config");
    expect(top).toEqual(["ai", "server"]);

    const ai = await fs.readdir("/sys/config/ai");
    expect(ai).toEqual(["api_key", "model", "provider"]);

    const stat = await fs.stat("/sys/config/ai");
    expect(stat.isDirectory).toBe(true);

    const provider = await fs.readFile("/sys/config/ai/provider");
    expect(provider).toBe("anthropic\n");
  });

  it("lists nested /sys/users/{uid} directories based on user config key prefixes", async () => {
    const fs = makeConfigBackedFs(ROOT, {
      "users/0/ai/provider": "openai",
      "users/0/ai/model": "gpt-4.1",
      "users/1000/ai/model": "gpt-4.1-mini",
    });

    const users = await fs.readdir("/sys/users");
    expect(users).toEqual(["0", "1000"]);

    const user0 = await fs.readdir("/sys/users/0");
    expect(user0).toEqual(["ai"]);

    const user0Ai = await fs.readdir("/sys/users/0/ai");
    expect(user0Ai).toEqual(["model", "provider"]);
  });

  it("returns ENOENT for unknown config subtree", async () => {
    const fs = makeConfigBackedFs(ROOT, {
      "config/ai/provider": "anthropic",
    });
    await expect(fs.readdir("/sys/config/missing")).rejects.toThrow("ENOENT");
  });

  it("hides sensitive system config keys for non-root users", async () => {
    const fs = makeConfigBackedFs(SAM, {
      "config/ai/provider": "anthropic",
      "config/ai/model": "claude-sonnet-4-20250514",
      "config/ai/api_key": "sk-test",
    });

    const entries = await fs.readdir("/sys/config/ai");
    expect(entries).toEqual(["model", "provider"]);

    await expect(fs.readFile("/sys/config/ai/api_key")).rejects.toThrow("ENOENT");
  });

  it("shows only own user namespace under /sys/users for non-root users", async () => {
    const fs = makeConfigBackedFs(SAM, {
      "users/1000/ai/model": "gpt-4.1-mini",
      "users/1001/ai/model": "gpt-4.1",
    });

    const users = await fs.readdir("/sys/users");
    expect(users).toEqual(["1000"]);

    await expect(fs.readdir("/sys/users/1001")).rejects.toThrow("ENOENT");
  });
});

describe("GsvFs search", () => {
  const TEST_PREFIX = "test/search/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("treats metacharacters as literal plain text", async () => {
    await putFile(`${TEST_PREFIX}notes.txt`, "a.c\nabc\n", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(SAM);
    const result = await fs.search(`/${TEST_PREFIX}`, "a.c");

    expect(result.matches).toEqual([
      {
        path: `/${TEST_PREFIX}notes.txt`,
        line: 1,
        content: "a.c",
      },
    ]);
  });
});
