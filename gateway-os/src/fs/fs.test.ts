import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { R2FS, parseMode, isValidMode } from "./index";
import type { ProcessIdentity } from "../syscalls/system";

const ROOT: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
};

const SAM: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
};

const ALICE: ProcessIdentity = {
  uid: 1001,
  gid: 100,
  gids: [100],
  username: "alice",
  home: "/home/alice",
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

describe("R2FS permissions", () => {
  const TEST_PREFIX = "/test/perms/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("root (uid 0) can read any file", async () => {
    await putFile(`${TEST_PREFIX}secret.txt`, "top secret", {
      uid: "1000",
      gid: "1000",
      mode: "600",
    });

    const fs = new R2FS(env.STORAGE, ROOT);
    const result = await fs.read({ path: `${TEST_PREFIX}secret.txt` });
    expect(result.ok).toBe(true);
  });

  it("owner can read their own 600 file", async () => {
    await putFile(`${TEST_PREFIX}mine.txt`, "my data", {
      uid: "1000",
      gid: "1000",
      mode: "600",
    });

    const fs = new R2FS(env.STORAGE, SAM);
    const result = await fs.read({ path: `${TEST_PREFIX}mine.txt` });
    expect(result.ok).toBe(true);
  });

  it("non-owner is denied reading a 600 file", async () => {
    await putFile(`${TEST_PREFIX}private.txt`, "secret", {
      uid: "1000",
      gid: "1000",
      mode: "600",
    });

    const fs = new R2FS(env.STORAGE, ALICE);
    const result = await fs.read({ path: `${TEST_PREFIX}private.txt` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Permission denied");
  });

  it("group member can read a 640 file", async () => {
    await putFile(`${TEST_PREFIX}group-read.txt`, "group data", {
      uid: "1000",
      gid: "100",
      mode: "640",
    });

    // ALICE has gid 100 in her gids
    const fs = new R2FS(env.STORAGE, ALICE);
    const result = await fs.read({ path: `${TEST_PREFIX}group-read.txt` });
    expect(result.ok).toBe(true);
  });

  it("non-group member is denied reading a 640 file", async () => {
    await putFile(`${TEST_PREFIX}group-only.txt`, "group data", {
      uid: "999",
      gid: "999",
      mode: "640",
    });

    const fs = new R2FS(env.STORAGE, SAM);
    const result = await fs.read({ path: `${TEST_PREFIX}group-only.txt` });
    expect(result.ok).toBe(false);
  });

  it("anyone can read a 644 file", async () => {
    await putFile(`${TEST_PREFIX}public.txt`, "hello world", {
      uid: "0",
      gid: "0",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, ALICE);
    const result = await fs.read({ path: `${TEST_PREFIX}public.txt` });
    expect(result.ok).toBe(true);
  });

  it("non-owner is denied writing a 644 file", async () => {
    await putFile(`${TEST_PREFIX}readonly.txt`, "original", {
      uid: "0",
      gid: "0",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, SAM);
    const result = await fs.edit({
      path: `${TEST_PREFIX}readonly.txt`,
      oldString: "original",
      newString: "modified",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Permission denied");
  });

  it("owner can write their own 644 file", async () => {
    await putFile(`${TEST_PREFIX}owner-edit.txt`, "original", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, SAM);
    const result = await fs.edit({
      path: `${TEST_PREFIX}owner-edit.txt`,
      oldString: "original",
      newString: "modified",
    });
    expect(result.ok).toBe(true);
  });

  it("root can write any file", async () => {
    await putFile(`${TEST_PREFIX}root-edit.txt`, "original", {
      uid: "1000",
      gid: "1000",
      mode: "600",
    });

    const fs = new R2FS(env.STORAGE, ROOT);
    const result = await fs.edit({
      path: `${TEST_PREFIX}root-edit.txt`,
      oldString: "original",
      newString: "modified",
    });
    expect(result.ok).toBe(true);
  });

  it("root can delete any file", async () => {
    await putFile(`${TEST_PREFIX}root-del.txt`, "bye", {
      uid: "1000",
      gid: "1000",
      mode: "600",
    });

    const fs = new R2FS(env.STORAGE, ROOT);
    const result = await fs.delete({ path: `${TEST_PREFIX}root-del.txt` });
    expect(result.ok).toBe(true);
  });

  it("non-owner is denied deleting a file", async () => {
    await putFile(`${TEST_PREFIX}no-del.txt`, "stay", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, ALICE);
    const result = await fs.delete({ path: `${TEST_PREFIX}no-del.txt` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Permission denied");
  });
});

describe("R2FS write metadata", () => {
  const TEST_PREFIX = "/test/meta/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("write stamps uid, gid, and mode 644 on new files", async () => {
    const fs = new R2FS(env.STORAGE, SAM);
    await fs.write({ path: `${TEST_PREFIX}new.txt`, content: "hello" });

    const head = await env.STORAGE.head(`${TEST_PREFIX}new.txt`);
    expect(head?.customMetadata?.uid).toBe("1000");
    expect(head?.customMetadata?.gid).toBe("1000");
    expect(head?.customMetadata?.mode).toBe("644");
  });
});

describe("R2FS chmod", () => {
  const TEST_PREFIX = "/test/chmod/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("owner can chmod their file", async () => {
    await putFile(`${TEST_PREFIX}myfile.txt`, "data", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, SAM);
    const result = await fs.chmod({ path: `${TEST_PREFIX}myfile.txt`, mode: "600" });
    expect(result.ok).toBe(true);

    const head = await env.STORAGE.head(`${TEST_PREFIX}myfile.txt`);
    expect(head?.customMetadata?.mode).toBe("600");
  });

  it("root can chmod any file", async () => {
    await putFile(`${TEST_PREFIX}anyfile.txt`, "data", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, ROOT);
    const result = await fs.chmod({ path: `${TEST_PREFIX}anyfile.txt`, mode: "755" });
    expect(result.ok).toBe(true);
  });

  it("non-owner non-root is denied chmod", async () => {
    await putFile(`${TEST_PREFIX}notmine.txt`, "data", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, ALICE);
    const result = await fs.chmod({ path: `${TEST_PREFIX}notmine.txt`, mode: "777" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Permission denied");
  });

  it("rejects invalid mode strings", async () => {
    await putFile(`${TEST_PREFIX}valid.txt`, "data", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, SAM);
    const result = await fs.chmod({ path: `${TEST_PREFIX}valid.txt`, mode: "abc" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid mode");
  });

  it("returns error for nonexistent file", async () => {
    const fs = new R2FS(env.STORAGE, ROOT);
    const result = await fs.chmod({ path: `${TEST_PREFIX}ghost.txt`, mode: "644" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });
});

describe("R2FS chown", () => {
  const TEST_PREFIX = "/test/chown/";

  beforeEach(async () => {
    const listed = await env.STORAGE.list({ prefix: TEST_PREFIX });
    for (const obj of listed.objects) {
      await env.STORAGE.delete(obj.key);
    }
  });

  it("root can chown a file", async () => {
    await putFile(`${TEST_PREFIX}transfer.txt`, "data", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, ROOT);
    const result = await fs.chown({
      path: `${TEST_PREFIX}transfer.txt`,
      uid: 1001,
      gid: 100,
    });
    expect(result.ok).toBe(true);

    const head = await env.STORAGE.head(`${TEST_PREFIX}transfer.txt`);
    expect(head?.customMetadata?.uid).toBe("1001");
    expect(head?.customMetadata?.gid).toBe("100");
  });

  it("non-root is denied chown", async () => {
    await putFile(`${TEST_PREFIX}nochange.txt`, "data", {
      uid: "1000",
      gid: "1000",
      mode: "644",
    });

    const fs = new R2FS(env.STORAGE, SAM);
    const result = await fs.chown({
      path: `${TEST_PREFIX}nochange.txt`,
      uid: 1001,
      gid: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("only root");
  });

  it("returns error for nonexistent file", async () => {
    const fs = new R2FS(env.STORAGE, ROOT);
    const result = await fs.chown({
      path: `${TEST_PREFIX}ghost.txt`,
      uid: 0,
      gid: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });
});

describe("R2FS normalizePath", () => {
  it("resolves ~ to home", () => {
    const fs = new R2FS(env.STORAGE, SAM);
    expect(fs.normalizePath("~")).toBe("/home/sam");
    expect(fs.normalizePath("~/docs/file.md")).toBe("/home/sam/docs/file.md");
  });

  it("resolves ~ for root to /root", () => {
    const fs = new R2FS(env.STORAGE, ROOT);
    expect(fs.normalizePath("~")).toBe("/root");
    expect(fs.normalizePath("~/file.txt")).toBe("/root/file.txt");
  });

  it("resolves relative paths against cwd", () => {
    const fs = new R2FS(env.STORAGE, SAM);
    expect(fs.normalizePath("file.txt")).toBe("/home/sam/file.txt");
  });

  it("resolves .. segments", () => {
    const fs = new R2FS(env.STORAGE, SAM);
    expect(fs.normalizePath("/home/sam/docs/../file.txt")).toBe(
      "/home/sam/file.txt",
    );
  });

  it("absolute paths are used as-is", () => {
    const fs = new R2FS(env.STORAGE, SAM);
    expect(fs.normalizePath("/etc/passwd")).toBe("/etc/passwd");
  });

  it("respects custom cwd", () => {
    const fs = new R2FS(env.STORAGE, SAM, "/projects/myapp");
    expect(fs.normalizePath("src/main.ts")).toBe("/projects/myapp/src/main.ts");
  });
});
