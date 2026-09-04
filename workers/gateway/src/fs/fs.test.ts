import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { GsvFs, parseMode, isValidMode, resolveUserPath } from "./index";
import type { KernelRefs } from "./index";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { R2MountBackend } from "./backends/r2";

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

const SAM_AGENT: ProcessIdentity = {
  uid: 2000,
  gid: 2000,
  gids: [2000],
  username: "sam-agent",
  home: "/home/sam-agent",
  cwd: "/home/sam-agent",
};
type ExpectedSizeFixture = { expectedSize: number };

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

describe("GsvFs openFile", () => {
  it("returns a byte stream for backends without openFile", async () => {
    // SAFETY: this fixture supplies only the GsvFs methods exercised by the test.
    const fs = Object.create(GsvFs.prototype) as any;
    fs.resolveFinalPath = async (path: string) => path;
    fs.backendForPath = () => ({
      stat: async () => ({ isFile: true, isDirectory: false, size: 3, mtime: new Date(1) }),
      readFileBuffer: async () => new Uint8Array([1, 2, 3]),
    });

    const opened = await fs.openFile("/virtual.bin");
    const reader = opened.body.getReader({ mode: "byob" });
    const { value } = await reader.read(new Uint8Array(3));

    expect(value).toEqual(new Uint8Array([1, 2, 3]));
    reader.releaseLock();
  });

  it("returns an empty byte stream for empty fallback files", async () => {
    // SAFETY: this fixture supplies only the GsvFs methods exercised by the test.
    const fs = Object.create(GsvFs.prototype) as any;
    fs.resolveFinalPath = async (path: string) => path;
    fs.backendForPath = () => ({
      stat: async () => ({ isFile: true, isDirectory: false, size: 0, mtime: new Date(1) }),
      readFileBuffer: async () => new Uint8Array(),
    });

    const opened = await fs.openFile("/empty.bin");
    const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());

    expect(opened.size).toBe(0);
    expect(bytes).toEqual(new Uint8Array());
  });
});

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
    // SAFETY: these kernel stores are unused by the config-backed fixture.
    auth: null as never,
    // SAFETY: these kernel stores are unused by the config-backed fixture.
    procs: null as never,
    // SAFETY: these kernel stores are unused by the config-backed fixture.
    devices: null as never,
    // SAFETY: these kernel stores are unused by the config-backed fixture.
    caps: null as never,
    // SAFETY: the fixture implements the config contract used by GsvFs.
    config: config as never,
  });
}

function makeRuntimeViewFs(
  identity: ProcessIdentity,
  selfPid?: string,
  configOverrides: Record<string, string> = {},
): GsvFs {
  const processRecord = {
    processId: "task-alpha",
    parentPid: "init:1000",
    uid: 1000,
    ownerUid: 1000,
    profile: "task",
    gid: 1000,
    gids: [1000],
    username: "sam",
    home: "/home/sam",
    cwd: "/home/sam",
    state: "idle",
    activeRunId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: "Alpha",
    createdAt: 100,
  };
  const otherProcessRecord = {
    ...processRecord,
    processId: "task-foreign",
    uid: 1001,
    ownerUid: 1001,
    username: "alice",
  };
  const personalAgentProcessRecord = {
    ...processRecord,
    processId: "task-personal",
    uid: SAM_AGENT.uid,
    ownerUid: 1000,
    gid: SAM_AGENT.gid,
    gids: SAM_AGENT.gids,
    username: SAM_AGENT.username,
    home: SAM_AGENT.home,
    cwd: SAM_AGENT.cwd,
  };
  const history = [
    { id: 1, role: "user", content: "hello", timestamp: 1000 },
    { id: 2, role: "assistant", content: { text: "hi" }, timestamp: 1100 },
  ];
  const segment = {
    id: "seg-1",
    generation: 1,
    kind: "compaction",
    fromMessageId: 1,
    toMessageId: 1,
    archivePath: "/var/sessions/sam/task-alpha/history/seg-1.jsonl.gz",
    summaryMessageId: 2,
    createdAt: 1300,
  };
  const segmentMessages = [
    { id: 1, role: "user", content: "archived hello", timestamp: 1000 },
  ];
  const schedules = [
    {
      id: "sched-1",
      ownerUid: 1000,
      creator: { kind: "human", uid: 1000, username: "sam" },
      runAs: { kind: "human", uid: 1000, username: "sam" },
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
      creator: { kind: "human", uid: 1001, username: "alice" },
      runAs: { kind: "human", uid: 1001, username: "alice" },
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
  let samCrontab = "CRON_TZ=Europe/Amsterdam\n0 9 * * * proc spawn --as sam-agent --non-interactive --label daily-pulse \"Daily pulse\"\n";
  const systemCrontabs = new Map<string, string>([
    ["daily", "0 5 * * * proc compact init:1000 --keep-last 80\n"],
  ]);
  const configEntries = new Map<string, string>([
    ["config/ai/models", JSON.stringify({
      version: 1,
      models: [{ id: "system", name: "System", provider: "workers-ai", model: "@cf/system/model" }],
    })],
    ["config/ai/models/system/api_key", "sk-system"],
    ["config/ai/image/read/max_objects", "150"],
    ["config/ai/speech/provider", "workers-ai"],
    ["users/1000/ai/models", JSON.stringify({
      version: 1,
      models: [{
        id: "fast-stack",
        name: "Fast Stack",
        provider: "openai",
        model: "gpt-4.1-mini",
      }],
    })],
    ["users/1000/ai/models/fast-stack/api_key", "sk-model"],
  ]);
  for (const [key, value] of Object.entries(configOverrides)) {
    configEntries.set(key, value);
  }
  let processAiConfig: any = null;
  const passwdEntries = [ROOT, SAM, ALICE, SAM_AGENT].map((user) => ({
    username: user.username,
    uid: user.uid,
    gid: user.gid,
    gecos: user.username,
    home: user.home,
    shell: "/bin/sh",
  }));
  const canAccessCrontab = (username: string) => identity.uid === 0 || identity.username === username;

  // SAFETY: this test kernel supplies typed behavior for only the exercised stores.
  const kernel: KernelRefs = {
    auth: {
      getPasswdByUsername(username: string) {
        return passwdEntries.find((entry) => entry.username === username) ?? null;
      },
      getPasswdByUid(uid: number) {
        return passwdEntries.find((entry) => entry.uid === uid) ?? null;
      },
      getPersonalAgentUid(ownerUid: number) {
        return ownerUid === SAM.uid ? SAM_AGENT.uid : null;
      },
    // SAFETY: the fixture implements the auth methods used by this test.
    } /* SAFETY: typed fixture implements the auth subset used here. */ as never,
    procs: {
      get(pid: string) {
        if (pid === "task-alpha") return processRecord;
        if (pid === "task-personal") return personalAgentProcessRecord;
        if (pid === "task-foreign") return otherProcessRecord;
        return null;
      },
      getOwnerUid(pid: string) {
        return this.get(pid)?.ownerUid ?? null;
      },
      list(ownerUid?: number) {
        return [processRecord, personalAgentProcessRecord, otherProcessRecord]
          .filter((record) => ownerUid === undefined || record.ownerUid === ownerUid);
      },
    // SAFETY: the fixture implements the process methods used by this test.
    } /* SAFETY: typed fixture implements the process subset used here. */ as never,
    conversations: {
      getDefault(ownerUid: number, agentUid: number) {
        return ownerUid === SAM.uid && agentUid === SAM_AGENT.uid
          ? { activePid: "task-personal" }
          : null;
      },
    // SAFETY: the fixture implements the conversation methods used by this test.
    } /* SAFETY: typed fixture implements the conversation subset used here. */ as never,
    // SAFETY: these kernel stores are unused by the runtime-view fixture.
    devices: null /* SAFETY: unused fixture store. */ as never,
    // SAFETY: these kernel stores are unused by the runtime-view fixture.
    caps: null /* SAFETY: unused fixture store. */ as never,
    config: {
      get(key: string) {
        return configEntries.get(key) ?? null;
      },
      getExplicit(key: string) {
        return configEntries.get(key) ?? null;
      },
      set(key: string, value: string) {
        configEntries.set(key, value);
      },
      list(prefix: string) {
        const normalized = prefix.trim();
        const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
        return [...configEntries.entries()]
          .filter(([key]) => key.startsWith(withSlash))
          .map(([key, value]) => ({ key, value }));
      },
    // SAFETY: the fixture implements the config methods used by this test.
    } /* SAFETY: typed fixture implements the config subset used here. */ as never,
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
        return [...systemCrontabs.keys()].sort();
      },
      readSystemCrontab(name: string) {
        return systemCrontabs.get(name);
      },
      async installSystemCrontab(name: string, content: string) {
        if (identity.uid !== 0) throw new Error("Permission denied: cannot install system crontabs");
        systemCrontabs.set(name, content.endsWith("\n") ? content : `${content}\n`);
      },
      async removeSystemCrontab(name: string) {
        if (identity.uid !== 0) throw new Error("Permission denied: cannot remove system crontabs");
        return systemCrontabs.delete(name);
      },
    },
    schedules: {
      list(args) {
        const records = schedules.filter((schedule) => args.ownerUid === undefined || schedule.ownerUid === args.ownerUid);
        type ScheduleFixture = (typeof schedules)[number];
        // SAFETY: the schedule fixtures match the view fields exercised here.
        return { records: records as ScheduleFixture[], count: records.length };
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
    async processRequest(pid, call, args) {
      if (call === "proc.ai.config.get") {
        return { ok: true, pid, config: processAiConfig };
      }
      if (call === "proc.ai.config.set") {
        const now = 2500;
        if ("clear" in args && args.clear === true) {
          processAiConfig = null;
          return { ok: true, pid, config: null };
        }
        const modelId = args.modelId === undefined
          ? processAiConfig?.modelId
          : args.modelId || undefined;
        const reasoning = args.reasoning === undefined
          ? processAiConfig?.reasoning
          : args.reasoning || undefined;
        processAiConfig = modelId || reasoning
          ? { version: 2, modelId, reasoning, updatedAt: now }
          : null;
        return { ok: true, pid, config: processAiConfig };
      }
      if (call === "proc.history") {
        const offset = Number(args?.offset ?? 0);
        const limit = Number(args?.limit ?? 500);
        return {
          ok: true,
          pid: "task-alpha",
          messages: history.slice(offset, offset + limit),
          messageCount: history.length,
        };
      }
      if (call === "proc.history.segments") {
        return {
          ok: true,
          pid: "task-alpha",
          segments: [segment],
        };
      }
      if (call === "proc.history.segment.read") {
        return {
          ok: true,
          pid: "task-alpha",
          segment,
          messages: segmentMessages,
          messageCount: segmentMessages.length,
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

  it("appends binary files without UTF-8 conversion", async () => {
    const fs = makeFs(SAM);
    const path = `/${TEST_PREFIX}binary.dat`;

    await fs.writeFile(path, new Uint8Array([0xff, 0x00, 0x80]));
    await fs.appendFile(path, new Uint8Array([0xfe, 0x61]));

    await expect(fs.readFileBuffer(path)).resolves.toEqual(
      new Uint8Array([0xff, 0x00, 0x80, 0xfe, 0x61]),
    );
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

  it("cancels streamed R2 writes", async () => {
    const fs = makeFs(SAM);
    const path = `/${TEST_PREFIX}cancelled-stream.txt`;
    let read!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      read = resolve;
    });
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        read();
      },
      cancel(reason) {
        cancelled = reason;
      },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const reason = new Error("write cancelled");
    const write = fs.writeFileStream(path, stream, {
      expectedSize: 1,
      signal: controller.signal,
    });
    await readStarted;

    controller.abort(reason);

    await expect(write).rejects.toEqual(reason);
    expect(cancelled).toBe(reason);
    expect(await env.STORAGE.head(path.slice(1))).toBeNull();
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
      // SAFETY: this fixture intentionally omits expectedSize to test validation.
      {} as ExpectedSizeFixture,
    )).rejects.toThrow("expectedSize");
  });

  it("falls back to exact-size buffering for non-streaming backends", async () => {
    // SAFETY: this fixture intentionally leaves unrelated kernel stores unavailable.
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
    // SAFETY: this fixture intentionally leaves unrelated kernel stores unavailable.
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
    // SAFETY: this fixture intentionally leaves unrelated kernel stores unavailable.
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

  it("cancels buffered stream writes", async () => {
    // SAFETY: this fixture supplies only the GsvFs methods exercised by the test.
    const fs = Object.create(GsvFs.prototype) as any;
    let written = false;
    fs.resolveFinalPath = async (path: string) => path;
    fs.backendForPath = () => ({
      writeFile: async () => {
        written = true;
      },
    });
    let read!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      read = resolve;
    });
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        read();
      },
      cancel(reason) {
        cancelled = reason;
      },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const reason = new Error("write cancelled");
    const write = fs.writeFileStream("/virtual.bin", stream, {
      expectedSize: 1,
      signal: controller.signal,
    });
    await readStarted;

    controller.abort(reason);

    await expect(write).rejects.toBe(reason);
    expect(cancelled).toBe(reason);
    expect(written).toBe(false);
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
    // SAFETY: this fixture intentionally leaves unrelated kernel stores unavailable.
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
  it("lists the kernel views under /sys by their current names", async () => {
    const fs = makeConfigBackedFs(ROOT, {});

    expect(await fs.readdir("/sys")).toEqual(["capabilities", "config", "targets", "users"]);
  });

  it("lists nested /sys/config directories based on config key prefixes", async () => {
    const models = JSON.stringify({
      version: 1,
      models: [{ id: "claude", name: "Claude", provider: "anthropic", model: "claude-sonnet-4-6" }],
    });
    const fs = makeConfigBackedFs(ROOT, {
      "config/ai/models": models,
      "config/ai/models/claude/api_key": "sk-test",
      "config/server/name": "gsv",
    });

    const top = await fs.readdir("/sys/config");
    expect(top).toEqual(["ai", "server"]);

    const ai = await fs.readdir("/sys/config/ai");
    expect(ai).toEqual(["models"]);

    const stat = await fs.stat("/sys/config/ai");
    expect(stat.isDirectory).toBe(true);

    await expect(fs.readFile("/sys/config/ai/models")).resolves.toBe(`${models}\n`);
  });

  it("lists nested /sys/users/{uid} directories based on user config key prefixes", async () => {
    const fs = makeConfigBackedFs(ROOT, {
      "users/0/ai/preferred_model": "gpt-4.1",
      "users/1000/ai/preferred_model": "gpt-4.1-mini",
    });

    const users = await fs.readdir("/sys/users");
    expect(users).toEqual(["0", "1000"]);

    const user0 = await fs.readdir("/sys/users/0");
    expect(user0).toEqual(["ai"]);

    const user0Ai = await fs.readdir("/sys/users/0/ai");
    expect(user0Ai).toEqual(["preferred_model"]);
  });

  it("returns ENOENT for unknown config subtree", async () => {
    const fs = makeConfigBackedFs(ROOT, {
      "config/ai/models": "{}",
    });
    await expect(fs.readdir("/sys/config/missing")).rejects.toThrow("ENOENT");
  });

  it("hides sensitive system config keys for non-root users", async () => {
    const models = JSON.stringify({
      version: 1,
      models: [{ id: "claude", name: "Claude", provider: "anthropic", model: "claude-sonnet-4-6" }],
    });
    const fs = makeConfigBackedFs(SAM, {
      "config/ai/models": models,
      "config/ai/models/claude/api_key": "sk-test",
    });

    const entries = await fs.readdir("/sys/config/ai");
    expect(entries).toEqual(["models"]);

    await expect(fs.readFile("/sys/config/ai/models/claude/api_key")).rejects.toThrow("ENOENT");
  });

  it("shows only own user namespace under /sys/users for non-root users", async () => {
    const fs = makeConfigBackedFs(SAM, {
      "users/1000/ai/preferred_model": "gpt-4.1-mini",
      "users/1001/ai/preferred_model": "gpt-4.1",
    });

    const users = await fs.readdir("/sys/users");
    expect(users).toEqual(["1000"]);

    await expect(fs.readdir("/sys/users/1001")).rejects.toThrow("ENOENT");
  });
});

describe("GsvFs Linux-like runtime views", () => {
  it("exposes process media through a stable read-only filesystem path", async () => {
    const ownKey = "var/media/1000/task-alpha/own-media";
    const siblingKey = "var/media/2000/task-personal/sibling-media";
    await env.STORAGE.put(ownKey, new Uint8Array([1, 2, 3, 4]), {
      httpMetadata: { contentType: "image/png" },
    });
    await env.STORAGE.put(siblingKey, new Uint8Array([5, 6]), {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    try {
      const fs = makeRuntimeViewFs(SAM_AGENT, "task-personal");
      await expect(fs.readdir("/var")).resolves.toContain("media");
      await expect(fs.readdir("/var/media")).resolves.toEqual(["1000", "2000"]);
      await expect(fs.readdir("/var/media/1000/task-alpha")).resolves.toEqual(["own-media"]);
      await expect(fs.readFileBuffer(`/${ownKey}`)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
      await expect(fs.readFileBuffer(`/${siblingKey}`)).resolves.toEqual(new Uint8Array([5, 6]));

      const stat = await fs.statExtended(`/${ownKey}`);
      expect(stat).toMatchObject({
        isFile: true,
        mode: 0o400,
        uid: 1000,
        gid: 1000,
        contentType: "image/png",
      });

      const opened = await fs.openFile(`/${ownKey}`, { range: { offset: 1, length: 2 } });
      expect(opened).toMatchObject({ status: 206, size: 2, totalSize: 4 });
      expect(new Uint8Array(await new Response(opened.body).arrayBuffer())).toEqual(new Uint8Array([2, 3]));

      await expect(fs.writeFile(`/${ownKey}`, "replacement")).rejects.toThrow("EROFS");
      await expect(fs.rm(`/${ownKey}`)).rejects.toThrow("EROFS");
    } finally {
      await env.STORAGE.delete([ownKey, siblingKey]);
    }
  });

  it("does not expose media owned by another user's process", async () => {
    const foreignKey = "var/media/1001/task-foreign/foreign-media";
    await env.STORAGE.put(foreignKey, new Uint8Array([9]), {
      httpMetadata: { contentType: "image/png" },
    });

    try {
      const fs = makeRuntimeViewFs(SAM, "task-alpha");
      await expect(fs.readdir("/var/media")).resolves.toEqual(["1000", "2000"]);
      await expect(fs.exists(`/${foreignKey}`)).resolves.toBe(false);

      const rootFs = makeRuntimeViewFs(ROOT);
      await expect(rootFs.readFileBuffer(`/${foreignKey}`)).resolves.toEqual(new Uint8Array([9]));
    } finally {
      await env.STORAGE.delete(foreignKey);
    }
  });

  it("exposes process history and compacted segments under /proc", async () => {
    const fs = makeRuntimeViewFs(SAM, "task-alpha");

    await expect(fs.readdir("/proc/task-alpha")).resolves.toEqual([
      "ai",
      "history",
      "identity",
      "segments",
      "status",
    ]);

    const historyLines = (await fs.readFile("/proc/task-alpha/history"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(historyLines).toEqual([
      expect.objectContaining({ id: 1, role: "user" }),
      expect.objectContaining({ id: 2, role: "assistant" }),
    ]);

    await expect(fs.readdir("/proc/task-alpha/segments")).resolves.toEqual(["seg-1"]);
    const segmentLines = (await fs.readFile("/proc/task-alpha/segments/seg-1"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(segmentLines).toEqual([
      expect.objectContaining({ id: 1, content: "archived hello" }),
    ]);

  });

  it("does not expose /proc/self outside a process", async () => {
    const fs = makeRuntimeViewFs(SAM);

    await expect(fs.readdir("/proc")).resolves.toEqual([
      "task-alpha",
      "task-personal",
      "uptime",
      "version",
    ]);
    await expect(fs.readdir("/proc/self")).rejects.toThrow("ENOENT");
  });

  it("keeps /proc/self visible inside a personal-agent executor", async () => {
    const fs = makeRuntimeViewFs(SAM_AGENT, "task-personal");

    await expect(fs.readdir("/proc")).resolves.toEqual([
      "self",
      "task-alpha",
      "task-personal",
      "uptime",
      "version",
    ]);
    await expect(fs.readdir("/proc/self")).resolves.toEqual([
      "ai",
      "history",
      "identity",
      "segments",
      "status",
    ]);

    const selfStatus = await fs.readFile("/proc/self/status");
    expect(selfStatus).toContain("Pid:\ttask-personal");
    expect(selfStatus).toContain("Uid:\t2000");

    const siblingStatus = await fs.readFile("/proc/task-alpha/status");
    expect(siblingStatus).toContain("Pid:\ttask-alpha");
    await expect(fs.readdir("/proc/task-foreign")).rejects.toThrow("ENOENT");
  });

  it("hides another user's process history view from non-root users", async () => {
    const fs = makeRuntimeViewFs(SAM);

    await expect(fs.readdir("/proc/task-foreign")).rejects.toThrow("ENOENT");
  });

  it("mirrors the owner's preferred model in the process view", async () => {
    const owner = makeRuntimeViewFs(SAM, "task-alpha", { "users/1000/ai/preferred_model": "system" });
    expect(JSON.parse(await owner.readFile("/proc/task-alpha/ai/effective.json")))
      .toMatchObject({ modelId: "system" });

    // A cleared agent preference inherits the owner's choice.
    const agent = makeRuntimeViewFs(SAM_AGENT, "task-personal", {
      "users/1000/ai/preferred_model": "system",
      "users/2000/ai/preferred_model": "",
    });
    expect(JSON.parse(await agent.readFile("/proc/task-personal/ai/effective.json")))
      .toMatchObject({ modelId: "system" });

    // A preference naming no listed model falls back to the layered order.
    const unknown = makeRuntimeViewFs(SAM, "task-alpha", { "users/1000/ai/preferred_model": "missing" });
    expect(JSON.parse(await unknown.readFile("/proc/task-alpha/ai/effective.json")))
      .toMatchObject({ modelId: "fast-stack" });
  });

  it("applies Process model and reasoning preferences through /proc", async () => {
    const fs = makeRuntimeViewFs(SAM, "task-alpha");

    await expect(fs.readdir("/proc/task-alpha/ai")).resolves.toEqual([
      "effective.json",
      "local.json",
      "model",
      "models",
      "reasoning",
    ]);

    const models = JSON.parse(await fs.readFile("/proc/task-alpha/ai/models"));
    expect(models[0]).toMatchObject({
      id: "fast-stack",
      name: "Fast Stack",
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    await fs.writeFile("/proc/task-alpha/ai/model", "fast-stack");
    await fs.writeFile("/proc/task-alpha/ai/reasoning", "high");

    await expect(fs.readFile("/proc/task-alpha/ai/model")).resolves.toBe("fast-stack\n");
    await expect(fs.readFile("/proc/task-alpha/ai/reasoning")).resolves.toBe("high\n");

    const local = JSON.parse(await fs.readFile("/proc/task-alpha/ai/local.json"));
    expect(local).toMatchObject({
      version: 2,
      modelId: "fast-stack",
      reasoning: "high",
    });

    const effective = JSON.parse(await fs.readFile("/proc/task-alpha/ai/effective.json"));
    expect(effective).toEqual({
      modelId: "fast-stack",
      reasoning: "high",
    });

    await fs.writeFile("/proc/task-alpha/ai/model", "");
    await expect(fs.readFile("/proc/task-alpha/ai/model")).resolves.toBe("\n");
  });

  it("exposes crontabs and scheduler run history under /var", async () => {
    const fs = makeRuntimeViewFs(SAM);

    await expect(fs.readdir("/var")).resolves.toEqual(expect.arrayContaining(["log", "spool"]));
    await expect(fs.readdir("/var/spool/cron")).resolves.toEqual(["sam"]);
    await expect(fs.writeFile("/var/log/custom", "hidden")).rejects.toThrow("EPERM");

    const crontab = await fs.readFile("/var/spool/cron/sam");
    expect(crontab).toContain("CRON_TZ=Europe/Amsterdam");
    expect(crontab).toContain("proc spawn --as sam-agent");
    const crontabStat = await fs.statExtended("/var/spool/cron/sam");
    expect(crontabStat).toMatchObject({
      isFile: true,
      mode: 0o600,
      uid: SAM.uid,
      gid: SAM.gid,
    });
    expect(crontabStat.size).toBeGreaterThan(0);

    await fs.writeFile("/var/spool/cron/sam", "0 4 * * * proc compact init:1000 --keep-last 80\n");
    await expect(fs.readFile("/var/spool/cron/sam"))
      .resolves.toBe("0 4 * * * proc compact init:1000 --keep-last 80\n");

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

  it("resolves system crontabs through virtual /etc parents", async () => {
    const fs = makeRuntimeViewFs(SAM);

    await expect(fs.readdir("/etc")).resolves.toEqual(expect.arrayContaining(["cron.d", "group", "passwd", "shadow"]));
    await expect(fs.readdir("/etc/cron.d")).resolves.toEqual(["daily"]);
    await expect(fs.readFile("/etc/cron.d/daily")).resolves.toContain("proc compact");
    await expect(fs.statExtended("/etc/cron.d/daily")).resolves.toMatchObject({
      isFile: true,
      mode: 0o644,
      uid: 0,
      gid: 0,
    });
    await expect(fs.writeFile("/etc/cron.d/nightly", "0 4 * * * proc list\n")).rejects.toThrow("Permission denied");

    const rootFs = makeRuntimeViewFs(ROOT);
    await rootFs.writeFile("/etc/cron.d/nightly", "0 4 * * * proc list\n");
    await expect(rootFs.readFile("/etc/cron.d/nightly")).resolves.toBe("0 4 * * * proc list\n");
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

  it("searches a specific file path", async () => {
    await putFile(`${TEST_PREFIX}nested_test.txt`, "nested\nsearchtest\n", {
      uid: "1000", gid: "1000", mode: "644",
    });
    await putFile(`${TEST_PREFIX}other.txt`, "searchtest outside target\n", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(SAM);
    const result = await fs.search(`/${TEST_PREFIX}nested_test.txt`, "searchtest");

    expect(result.matches).toEqual([
      {
        path: `/${TEST_PREFIX}nested_test.txt`,
        line: 2,
        content: "searchtest",
      },
    ]);
  });

  it("does not return unreadable files from broad searches", async () => {
    await putFile(`${TEST_PREFIX}private.txt`, "secret-needle\n", {
      uid: "1001", gid: "1001", mode: "600",
    });
    await putFile(`${TEST_PREFIX}public.txt`, "secret-needle\n", {
      uid: "1000", gid: "1000", mode: "644",
    });

    const fs = makeFs(SAM);
    const result = await fs.search(`/${TEST_PREFIX}`, "secret-needle");

    expect(result.matches).toEqual([
      {
        path: `/${TEST_PREFIX}public.txt`,
        line: 1,
        content: "secret-needle",
      },
    ]);
  });

  it("cancels a file body read", async () => {
    let startRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      startRead = resolve;
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        startRead();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const object = {
      body,
      customMetadata: { uid: "1000", gid: "1000", mode: "644" },
      httpMetadata: { contentType: "text/plain" },
      key: `${TEST_PREFIX}slow.txt`,
      size: 1,
    };
    // SAFETY: this fixture implements only the R2 get method exercised by the test.
    const backend = new R2MountBackend({
      get: async () => object,
    } /* SAFETY: fixture implements only the R2 get method exercised here. */ as R2Bucket, SAM);
    const controller = new AbortController();
    const reason = new Error("search cancelled");

    const search = backend.search(`/${object.key}`, "needle", undefined, controller.signal);
    await reading;
    controller.abort(reason);

    await expect(search).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });
});

describe("GsvFs stat identity", () => {
  it("reports a stable identity that survives repeated stats and follows links", async () => {
    const fs = new GsvFs(env.STORAGE, {
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "sam",
      home: "/home/sam",
      cwd: "/home/sam",
    });
    await fs.mkdir("/home/sam/identity", { recursive: true });
    await fs.writeFile("/home/sam/identity/a.txt", "a");
    await fs.writeFile("/home/sam/identity/b.txt", "b");

    const first = await fs.stat("/home/sam/identity/a.txt");
    const again = await fs.stat("/home/sam/identity/a.txt");
    const other = await fs.stat("/home/sam/identity/b.txt");

    expect(first.identity).toBeDefined();
    expect(again.identity).toBe(first.identity);
    expect(other.identity).not.toBe(first.identity);
    expect((await fs.stat("/")).identity).toBeDefined();
  });
});
