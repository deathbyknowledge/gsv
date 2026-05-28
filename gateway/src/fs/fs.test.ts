import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { GsvFs, parseMode, isValidMode, resolveUserPath } from "./index";
import type { KernelRefs } from "./index";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";

const ROOT: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

const SAM: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

const ALICE: ProcessIdentity = {
  uid: 1001,
  gid: 100,
  gids: [100],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
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

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
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
  });
}

function makeRuntimeViewFs(identity: ProcessIdentity, selfPid?: string): GsvFs {
  const processRecord = {
    processId: "task-alpha",
    parentPid: "init:1000",
    uid: 1000,
    profile: "task",
    gid: 1000,
    gids: [1000],
    username: "sam",
    home: "/home/sam",
    cwd: "/home/sam",
    state: "idle",
    activeRunId: null,
    activeConversationId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: "Alpha",
    createdAt: 100,
    mounts: [],
    contextFiles: [{ name: "brief.md", text: "Brief" }],
  };
  const otherProcessRecord = {
    ...processRecord,
    processId: "task-foreign",
    uid: 1001,
    username: "alice",
  };
  const conversations = [
    {
      id: "default",
      generation: 1,
      status: "open",
      title: null,
      messageCount: 2,
      createdAt: 1000,
      updatedAt: 2000,
    },
    {
      id: "build",
      generation: 2,
      status: "open",
      title: "Build",
      messageCount: 1,
      createdAt: 1100,
      updatedAt: 2100,
    },
  ];
  const history = {
    default: [
      { id: 1, role: "user", content: "hello", timestamp: 1000 },
      { id: 2, role: "assistant", content: { text: "hi" }, timestamp: 1100 },
    ],
    build: [
      { id: 3, role: "user", content: "run build", timestamp: 1200 },
    ],
  };
  const segment = {
    id: "seg-1",
    conversationId: "default",
    generation: 1,
    kind: "compaction",
    fromMessageId: 1,
    toMessageId: 1,
    archivePath: "/var/sessions/sam/task-alpha/conversations/default/seg-1.jsonl.gz",
    summaryMessageId: 2,
    createdAt: 1300,
  };
  const segmentMessages = [
    { id: 1, role: "user", content: "archived hello", timestamp: 1000 },
  ];
  const archive = {
    id: "reset-1",
    conversationId: "default",
    generation: 1,
    kind: "reset",
    messages: 2,
    archivePath: "/var/sessions/sam/task-alpha/conversations/default/reset-1.jsonl.gz",
    createdAt: 1600,
  };
  const liveGeneration = {
    conversationId: "default",
    generation: 1,
    messageCount: 2,
    firstMessageId: 1,
    lastMessageId: 2,
    updatedAt: 2000,
  };
  const schedules = [
    {
      id: "sched-1",
      ownerUid: 1000,
      creator: { kind: "user", uid: 1000, username: "sam" },
      runAs: { kind: "user", uid: 1000, username: "sam" },
      name: "daily pulse",
      enabled: true,
      expression: { kind: "every", everyMs: 60_000 },
      target: { kind: "process.event", pid: "task-alpha", message: "pulse" },
      overlapPolicy: "skip",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      state: {
        nextRunAtMs: 2000,
        runningAtMs: null,
        lastRunAtMs: 1500,
        lastStatus: "ok",
        lastError: null,
        lastDurationMs: 10,
        runCount: 1,
      },
    },
    {
      id: "sched-foreign",
      ownerUid: 1001,
      creator: { kind: "user", uid: 1001, username: "alice" },
      runAs: { kind: "user", uid: 1001, username: "alice" },
      name: "foreign",
      enabled: true,
      expression: { kind: "every", everyMs: 60_000 },
      target: { kind: "process.event", pid: "task-foreign", message: "pulse" },
      overlapPolicy: "skip",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      state: {
        nextRunAtMs: 2000,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    },
  ];
  const packages = [
    {
      packageId: "import:sam/tools:packages/weather",
      scope: { kind: "user", uid: 1000 },
      manifest: {
        name: "weather",
        description: "Weather tools",
        version: "1.2.3",
        runtime: "web-ui",
        source: {
          repo: "sam/tools",
          ref: "main",
          subdir: "packages/weather",
          resolvedCommit: "abc123",
        },
        entrypoints: [
          {
            name: "Weather",
            kind: "ui",
            module: "src/main.tsx",
            route: "/apps/weather",
          },
          {
            name: "Weather command",
            kind: "command",
            module: "src/backend.ts",
            command: "weather",
            description: "Fetch weather.",
            syscalls: ["fs.read"],
          },
        ],
        profiles: [
          {
            name: "forecast",
            displayName: "Forecast",
            contextFiles: [{ name: "brief.md", text: "Forecast context" }],
          },
        ],
        capabilities: {
          bindings: [{
            binding: "KERNEL",
            kind: "kernel",
            interfaceName: "gsv.kernel.v1",
            required: true,
          }],
        },
      },
      artifact: {
        hash: "sha256:weather",
        mainModule: "src/main.js",
        modulePaths: ["src/main.js", "src/backend.js"],
        publicFilePaths: ["browser/src/main.js"],
      },
      grants: {
        bindings: [{
          binding: "KERNEL",
          providerKind: "kernel-entrypoint",
          providerRef: "kernel://app/request",
        }],
      },
      enabled: true,
      reviewRequired: true,
      reviewedAt: 1700,
      installedAt: 1000,
      updatedAt: 2000,
    },
    {
      packageId: "builtin:chat@1.0.0",
      scope: { kind: "global" },
      manifest: {
        name: "chat",
        description: "Chat application",
        version: "1.0.0",
        runtime: "web-ui",
        source: {
          repo: "root/gsv",
          ref: "main",
          subdir: "builtin-packages/chat",
          resolvedCommit: "def456",
        },
        entrypoints: [{
          name: "Chat",
          kind: "ui",
          module: "src/main.tsx",
          route: "/apps/chat",
        }],
      },
      artifact: {
        hash: "sha256:chat",
        mainModule: "src/main.js",
        modulePaths: ["src/main.js"],
      },
      enabled: true,
      reviewRequired: false,
      reviewedAt: null,
      installedAt: 900,
      updatedAt: 1900,
    },
    {
      packageId: "import:alice/private:app",
      scope: { kind: "user", uid: 1001 },
      manifest: {
        name: "private",
        description: "Hidden package",
        version: "1.0.0",
        runtime: "web-ui",
        source: {
          repo: "alice/private",
          ref: "main",
          subdir: "app",
        },
        entrypoints: [{
          name: "Private",
          kind: "ui",
          module: "src/main.tsx",
          route: "/apps/private",
        }],
      },
      artifact: {
        hash: "sha256:private",
        mainModule: "src/main.js",
        modulePaths: ["src/main.js"],
      },
      enabled: true,
      reviewRequired: false,
      reviewedAt: null,
      installedAt: 800,
      updatedAt: 1800,
    },
  ];
  const packageScopeKey = (scope: any) => scope.kind === "user" ? `user:${scope.uid}` : "global";
  let samCrontab = "CRON_TZ=Europe/Amsterdam\n0 9 * * * proc spawn --profile cron \"Daily pulse\"\n";
  const passwdEntries = [ROOT, SAM, ALICE].map((user) => ({
    username: user.username,
    uid: user.uid,
    gid: user.gid,
    gecos: user.username,
    home: user.home,
    shell: "/bin/sh",
  }));
  const canAccessCrontab = (username: string) => identity.uid === 0 || identity.username === username;

  const kernel: KernelRefs = {
    auth: {
      getPasswdByUsername(username: string) {
        return passwdEntries.find((entry) => entry.username === username) ?? null;
      },
      getPasswdByUid(uid: number) {
        return passwdEntries.find((entry) => entry.uid === uid) ?? null;
      },
    } as never,
    procs: {
      get(pid: string) {
        if (pid === "task-alpha") return processRecord;
        if (pid === "task-foreign") return otherProcessRecord;
        return null;
      },
      list(uid?: number) {
        return [processRecord, otherProcessRecord].filter((record) => uid === undefined || record.uid === uid);
      },
    } as never,
    devices: null as never,
    caps: null as never,
    config: null as never,
    packages: {
      list(args?: { scopes?: any[]; enabled?: boolean; name?: string; runtime?: string }) {
        const visibleScopes = args?.scopes?.map(packageScopeKey);
        return packages.filter((record) => {
          if (visibleScopes && !visibleScopes.includes(packageScopeKey(record.scope))) return false;
          if (typeof args?.enabled === "boolean" && record.enabled !== args.enabled) return false;
          if (args?.name && record.manifest.name !== args.name) return false;
          if (args?.runtime && record.manifest.runtime !== args.runtime) return false;
          return true;
        }) as never;
      },
    } as never,
    cron: {
      listUserCrontabs() {
        return canAccessCrontab("sam") ? ["sam"] : [];
      },
      readUserCrontab(username: string) {
        if (username === "sam" && !canAccessCrontab(username)) {
          throw new Error(`Permission denied: cannot access crontab for ${username}`);
        }
        return username === "sam" ? samCrontab : undefined;
      },
      async installUserCrontab(username: string, content: string) {
        if (username !== "sam") throw new Error(`Unknown user: ${username}`);
        if (!canAccessCrontab(username)) throw new Error(`Permission denied: cannot access crontab for ${username}`);
        samCrontab = content.endsWith("\n") ? content : `${content}\n`;
      },
      async removeUserCrontab(username: string) {
        if (username !== "sam") return false;
        if (!canAccessCrontab(username)) throw new Error(`Permission denied: cannot access crontab for ${username}`);
        samCrontab = "";
        return true;
      },
      listSystemCrontabs() {
        return [];
      },
      readSystemCrontab() {
        return undefined;
      },
      async installSystemCrontab() {
        throw new Error("Permission denied: cannot install system crontabs");
      },
      async removeSystemCrontab() {
        return false;
      },
    },
    schedules: {
      list(args) {
        const records = schedules.filter((schedule) => args.ownerUid === undefined || schedule.ownerUid === args.ownerUid);
        return { records: records as never, count: records.length };
      },
      history(scheduleId: string) {
        if (scheduleId !== "sched-1") return [];
        return [{
          id: "run-1",
          scheduleId,
          scheduledAtMs: 1400,
          startedAtMs: 1401,
          finishedAtMs: 1411,
          status: "ok",
          result: { delivered: true },
        }];
      },
    },
    async processRequest(_pid, call, args) {
      const conversationId = String(args?.conversationId ?? "default");
      if (call === "proc.conversation.list") {
        return { ok: true, pid: "task-alpha", conversations };
      }
      if (call === "proc.conversation.get") {
        return {
          ok: true,
          pid: "task-alpha",
          conversation: conversations.find((conversation) => conversation.id === conversationId) ?? null,
        };
      }
      if (call === "proc.history") {
        const messages = history[conversationId as keyof typeof history] ?? [];
        const offset = Number(args?.offset ?? 0);
        const limit = Number(args?.limit ?? 500);
        return {
          ok: true,
          pid: "task-alpha",
          conversationId,
          messages: messages.slice(offset, offset + limit),
          messageCount: messages.length,
        };
      }
      if (call === "proc.conversation.segments") {
        return {
          ok: true,
          pid: "task-alpha",
          conversationId,
          segments: conversationId === "default" ? [segment] : [],
        };
      }
      if (call === "proc.conversation.segment.read") {
        return {
          ok: true,
          pid: "task-alpha",
          conversationId,
          segment,
          messages: segmentMessages,
          messageCount: segmentMessages.length,
        };
      }
      if (call === "proc.conversation.timeline") {
        return {
          ok: true,
          pid: "task-alpha",
          conversationId,
          timeline: conversationId === "default"
            ? [
                {
                  type: "segment",
                  id: segment.id,
                  conversationId: segment.conversationId,
                  generation: segment.generation,
                  segmentKind: segment.kind,
                  fromMessageId: segment.fromMessageId,
                  toMessageId: segment.toMessageId,
                  archivePath: segment.archivePath,
                  summaryMessageId: segment.summaryMessageId,
                  createdAt: segment.createdAt,
                },
                {
                  type: "archive",
                  id: archive.id,
                  conversationId: archive.conversationId,
                  generation: archive.generation,
                  archiveKind: archive.kind,
                  messages: archive.messages,
                  archivePath: archive.archivePath,
                  createdAt: archive.createdAt,
                },
                { type: "live", ...liveGeneration },
              ]
            : [{ type: "live", conversationId, generation: 2, messageCount: 1, firstMessageId: 3, lastMessageId: 3, updatedAt: 2100 }],
        };
      }
      if (call === "proc.conversation.generations") {
        return {
          ok: true,
          pid: "task-alpha",
          conversationId,
          generations: conversationId === "default" ? [1] : [2],
        };
      }
      if (call === "proc.conversation.generation.manifest") {
        const generation = Number(args?.generation);
        const isDefaultGeneration = conversationId === "default" && generation === 1;
        return {
          ok: true,
          pid: "task-alpha",
          conversationId,
          manifest: isDefaultGeneration
            ? {
                conversationId,
                generation,
                current: true,
                status: "open",
                title: null,
                archives: [archive],
                segments: [segment],
                live: liveGeneration,
              }
            : null,
        };
      }
      return { ok: false, error: "unknown call" };
    },
  };

  return new GsvFs(env.STORAGE, identity, kernel, selfPid);
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

  it("resolves R2 symbolic links across normal file operations", async () => {
    await putFile(`${TEST_PREFIX}target.txt`, "linked data", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(SAM);
    await fs.symlink(`/${TEST_PREFIX}target.txt`, `/${TEST_PREFIX}link.txt`);

    expect(await fs.readlink(`/${TEST_PREFIX}link.txt`)).toBe(`/${TEST_PREFIX}target.txt`);
    expect((await fs.lstat(`/${TEST_PREFIX}link.txt`)).isSymbolicLink).toBe(true);
    expect(await fs.readFile(`/${TEST_PREFIX}link.txt`)).toBe("linked data");
    expect((await fs.stat(`/${TEST_PREFIX}link.txt`)).isFile).toBe(true);
  });

  it("stats children through symlinked directories", async () => {
    const fs = makeFs(SAM);
    await fs.mkdir(`/${TEST_PREFIX}target-dir`, { recursive: true });
    await fs.mkdir(`/${TEST_PREFIX}target-dir/nested`, { recursive: true });
    await fs.writeFile(`/${TEST_PREFIX}target-dir/file.txt`, "linked data");
    await fs.symlink(`/${TEST_PREFIX}target-dir`, `/${TEST_PREFIX}dir-link`);

    const entries = await fs.readdirWithFileTypes(`/${TEST_PREFIX}dir-link`);
    const file = entries.find((entry) => entry.name === "file.txt");
    const nested = entries.find((entry) => entry.name === "nested");

    expect(file).toMatchObject({ isFile: true, isDirectory: false, isSymbolicLink: false });
    expect(nested).toMatchObject({ isFile: false, isDirectory: true, isSymbolicLink: false });
  });

  it("preserves virtual root and etc directories in lstat", async () => {
    const fs = makeConfigBackedFs(SAM, {});

    await expect(fs.lstat("/")).resolves.toMatchObject({
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    });
    await expect(fs.lstat("/etc")).resolves.toMatchObject({
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    });

    const rootEntries = await fs.readdirWithFileTypes("/");
    expect(rootEntries.find((entry) => entry.name === "etc")).toMatchObject({
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    });
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

  it("streams writes to R2 with supplied HTTP metadata", async () => {
    const fs = makeFs(SAM);
    const bytes = new TextEncoder().encode("streamed data");

    const result = await fs.writeFileStream(`/${TEST_PREFIX}stream.txt`, bytesToStream(bytes), {
      contentType: "text/plain; charset=utf-8",
      cacheControl: "public, max-age=60",
      expectedSize: bytes.byteLength,
    });

    const head = await env.STORAGE.head(`${TEST_PREFIX}stream.txt`);
    expect(result).toEqual({ size: bytes.byteLength, streamed: true });
    expect(head?.customMetadata?.uid).toBe("1000");
    expect(head?.customMetadata?.gid).toBe("1000");
    expect(head?.customMetadata?.mode).toBe("644");
    expect(head?.httpMetadata?.contentType).toBe("text/plain; charset=utf-8");
    expect(head?.httpMetadata?.cacheControl).toBe("public, max-age=60");
    expect(await fs.readFile(`/${TEST_PREFIX}stream.txt`)).toBe("streamed data");
  });

  it("streams writes through symlink targets", async () => {
    const fs = makeFs(SAM);
    const bytes = new TextEncoder().encode("updated");
    await fs.writeFile(`/${TEST_PREFIX}target.txt`, "original");
    await fs.symlink(`/${TEST_PREFIX}target.txt`, `/${TEST_PREFIX}stream-link.txt`);

    const result = await fs.writeFileStream(
      `/${TEST_PREFIX}stream-link.txt`,
      bytesToStream(bytes),
      { expectedSize: bytes.byteLength },
    );

    expect(result.streamed).toBe(true);
    expect(await fs.readFile(`/${TEST_PREFIX}target.txt`)).toBe("updated");
  });

  it("rejects stream writes without a declared size", async () => {
    const fs = makeFs(SAM);

    await expect(fs.writeFileStream(
      `/${TEST_PREFIX}unknown-length.txt`,
      bytesToStream(new TextEncoder().encode("buffered")),
      {} as { expectedSize: number },
    )).rejects.toThrow("expectedSize");
  });

  it("falls back to exact-size buffering for non-streaming backends", async () => {
    const fs = new GsvFs(env.STORAGE, SAM, {
      procs: null as never,
      devices: null as never,
      caps: null as never,
      config: null as never,
    });

    const result = await fs.writeFileStream(
      "/dev/null",
      bytesToStream(new TextEncoder().encode("discarded")),
      { expectedSize: 9 },
    );

    expect(result).toEqual({ size: 9, streamed: false });
  });

  it("rejects stream fallback content larger than the declared size", async () => {
    const fs = new GsvFs(env.STORAGE, SAM, {
      procs: null as never,
      devices: null as never,
      caps: null as never,
      config: null as never,
    });

    await expect(fs.writeFileStream(
      "/dev/null",
      bytesToStream(new TextEncoder().encode("too large")),
      { expectedSize: 3 },
    )).rejects.toThrow("EFBIG");
  });

  it("rejects stream fallback content smaller than the declared size", async () => {
    const fs = new GsvFs(env.STORAGE, SAM, {
      procs: null as never,
      devices: null as never,
      caps: null as never,
      config: null as never,
    });

    await expect(fs.writeFileStream(
      "/dev/null",
      bytesToStream(new TextEncoder().encode("short")),
      { expectedSize: 12 },
    )).rejects.toThrow("did not match expectedSize");
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

describe("GsvFs Linux-like runtime views", () => {
  it("exposes process conversations and compacted segments under /proc", async () => {
    const fs = makeRuntimeViewFs(SAM, "task-alpha");

    await expect(fs.readdir("/proc/task-alpha")).resolves.toEqual([
      "context.d",
      "conversations",
      "identity",
      "status",
    ]);
    await expect(fs.readdir("/proc/self/conversations")).resolves.toEqual(["build", "default"]);
    await expect(fs.readdir("/proc/task-alpha/conversations")).resolves.toEqual(["build", "default"]);
    await expect(fs.readdir("/proc/task-alpha/conversations/default")).resolves.toEqual([
      "generations",
      "history",
      "segments",
      "status",
      "timeline",
    ]);

    const status = JSON.parse(await fs.readFile("/proc/task-alpha/conversations/default/status"));
    expect(status).toMatchObject({ id: "default", generation: 1, messageCount: 2 });

    const historyLines = (await fs.readFile("/proc/task-alpha/conversations/default/history"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(historyLines).toEqual([
      expect.objectContaining({ id: 1, role: "user" }),
      expect.objectContaining({ id: 2, role: "assistant" }),
    ]);

    await expect(fs.readdir("/proc/task-alpha/conversations/default/segments")).resolves.toEqual(["seg-1"]);
    const segmentLines = (await fs.readFile("/proc/task-alpha/conversations/default/segments/seg-1"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(segmentLines).toEqual([
      expect.objectContaining({ id: 1, content: "archived hello" }),
    ]);

    const timelineLines = (await fs.readFile("/proc/task-alpha/conversations/default/timeline"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(timelineLines).toEqual([
      expect.objectContaining({ type: "segment", id: "seg-1" }),
      expect.objectContaining({ type: "archive", id: "reset-1", archiveKind: "reset" }),
      expect.objectContaining({ type: "live", generation: 1, messageCount: 2 }),
    ]);

    await expect(fs.readdir("/proc/task-alpha/conversations/default/generations")).resolves.toEqual(["1"]);
    await expect(fs.readdir("/proc/task-alpha/conversations/default/generations/1")).resolves.toEqual(["manifest"]);
    const manifest = JSON.parse(
      await fs.readFile("/proc/task-alpha/conversations/default/generations/1/manifest"),
    );
    expect(manifest).toMatchObject({
      conversationId: "default",
      generation: 1,
      current: true,
      archives: [expect.objectContaining({ id: "reset-1" })],
      segments: [expect.objectContaining({ id: "seg-1" })],
      live: expect.objectContaining({ messageCount: 2 }),
    });
  });

  it("hides another user's process conversation view from non-root users", async () => {
    const fs = makeRuntimeViewFs(SAM);

    await expect(fs.readdir("/proc/task-foreign")).rejects.toThrow("ENOENT");
  });

  it("exposes installed package status and metadata under /var/lib/gsv/packages", async () => {
    const fs = makeRuntimeViewFs(SAM);
    const weatherBase = encodeURIComponent("import:sam/tools:packages/weather");
    const chatBase = encodeURIComponent("builtin:chat@1.0.0");
    const hiddenBase = encodeURIComponent("import:alice/private:app");

    await expect(fs.readdir("/var/lib")).resolves.toEqual(["gsv"]);
    await expect(fs.readdir("/var/lib/gsv/packages")).resolves.toEqual(["info", "status"]);
    await expect(fs.readdir("/var/lib/gsv/packages/info")).resolves.toEqual([
      `${chatBase}.list`,
      `${chatBase}.manifest`,
      `${chatBase}.refs`,
      `${weatherBase}.list`,
      `${weatherBase}.manifest`,
      `${weatherBase}.refs`,
    ]);

    const status = await fs.readFile("/var/lib/gsv/packages/status");
    expect(status).toContain("Package: import:sam/tools:packages/weather");
    expect(status).toContain("Name: weather");
    expect(status).toContain("Enabled: yes");
    expect(status).toContain("Scope: user:1000");
    expect(status).toContain("Package: builtin:chat@1.0.0");
    expect(status).not.toContain("import:alice/private:app");

    const manifest = JSON.parse(await fs.readFile(`/var/lib/gsv/packages/info/${weatherBase}.manifest`));
    expect(manifest).toMatchObject({
      name: "weather",
      source: {
        repo: "sam/tools",
        subdir: "packages/weather",
      },
    });

    const refs = JSON.parse(await fs.readFile(`/var/lib/gsv/packages/info/${weatherBase}.refs`));
    expect(refs).toMatchObject({
      packageId: "import:sam/tools:packages/weather",
      source: {
        ref: "main",
        resolvedCommit: "abc123",
      },
      artifact: {
        hash: "sha256:weather",
      },
      paths: {
        source: "/src/packages/weather",
        commands: ["/usr/local/bin/weather"],
        publicFiles: ["/public/gsv/packages/sha256-weather/browser/src/main.js"],
      },
    });

    const packageList = (await fs.readFile(`/var/lib/gsv/packages/info/${weatherBase}.list`))
      .trim()
      .split("\n");
    expect(packageList).toEqual([
      `/var/lib/gsv/packages/info/${weatherBase}.list`,
      `/var/lib/gsv/packages/info/${weatherBase}.manifest`,
      `/var/lib/gsv/packages/info/${weatherBase}.refs`,
      "/src/packages/weather",
      "/usr/local/bin/weather",
      "/public/gsv/packages/sha256-weather/browser/src/main.js",
    ]);

    await expect(fs.readFile(`/var/lib/gsv/packages/info/${hiddenBase}.manifest`)).rejects.toThrow("ENOENT");
    await expect(fs.writeFile("/var/lib/gsv/packages/status", "nope")).rejects.toThrow("EPERM");
  });

  it("exposes crontabs and scheduler run history under /var", async () => {
    const fs = makeRuntimeViewFs(SAM);

    await expect(fs.readdir("/var")).resolves.toEqual(expect.arrayContaining(["log", "spool"]));
    await expect(fs.readdir("/var/spool/cron")).resolves.toEqual(["sam"]);
    await expect(fs.writeFile("/var/log/custom", "hidden")).rejects.toThrow("EPERM");

    const crontab = await fs.readFile("/var/spool/cron/sam");
    expect(crontab).toContain("CRON_TZ=Europe/Amsterdam");
    expect(crontab).toContain("proc spawn --profile cron");
    const crontabStat = await fs.statExtended("/var/spool/cron/sam");
    expect(crontabStat).toMatchObject({
      isFile: true,
      mode: 0o600,
      uid: SAM.uid,
      gid: SAM.gid,
    });
    expect(crontabStat.size).toBeGreaterThan(0);

    await fs.writeFile("/var/spool/cron/sam", "0 4 * * * proc compact init:1000 --conversation default --keep-last 80\n");
    await expect(fs.readFile("/var/spool/cron/sam"))
      .resolves.toBe("0 4 * * * proc compact init:1000 --conversation default --keep-last 80\n");

    const aliceFs = makeRuntimeViewFs(ALICE);
    await expect(aliceFs.readdir("/var/spool/cron")).resolves.toEqual([]);
    await expect(aliceFs.readFile("/var/spool/cron/sam")).rejects.toThrow("Permission denied");
    await expect(aliceFs.statExtended("/var/spool/cron/sam")).rejects.toThrow("Permission denied");
    await expect(aliceFs.writeFile("/var/spool/cron/sam", "0 1 * * * echo no\n")).rejects.toThrow("Permission denied");

    await expect(fs.readFile("/var/spool/cron/sched-foreign")).rejects.toThrow("ENOENT");

    const logLines = (await fs.readFile("/var/log/gsv/scheduler"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(logLines).toEqual([
      expect.objectContaining({
        id: "run-1",
        scheduleId: "sched-1",
        scheduleName: "daily pulse",
      }),
    ]);
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
