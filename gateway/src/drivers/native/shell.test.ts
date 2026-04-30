import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleShellExec } from "./shell";
import type { KernelContext } from "../../kernel/context";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { InstalledPackageRecord } from "../../kernel/packages";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

function makePackage(partial?: Partial<InstalledPackageRecord>): InstalledPackageRecord {
  return {
    packageId: "import:root/pkg-test:.",
    scope: { kind: "global" },
    manifest: {
      name: "ascii-starfield",
      description: "ASCII starfield",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "root/pkg-test",
        ref: "main",
        subdir: ".",
        resolvedCommit: "abc123",
      },
      entrypoints: [{ name: "Starfield", kind: "ui" }],
      capabilities: {
        bindings: [],
        egress: {
          mode: "none",
        },
      },
    },
    artifact: { hash: "hash1", mainModule: "index.js", modulePaths: ["index.js"] },
    grants: {
      bindings: [],
      egress: {
        mode: "none",
      },
    },
    enabled: false,
    reviewRequired: true,
    reviewedAt: null,
    installedAt: 1,
    updatedAt: 2,
    ...partial,
  } as InstalledPackageRecord;
}

function makeContext(options?: {
  capabilities?: string[];
  mounts?: Array<{ mountPath: string; packageId: string }>;
  pkg?: InstalledPackageRecord;
  procs?: Partial<KernelContext["procs"]>;
  schedules?: KernelContext["schedules"];
  getAppRunner?: KernelContext["getAppRunner"];
  scheduleScheduleWake?: KernelContext["scheduleScheduleWake"];
}): KernelContext {
  const pkg = options?.pkg ?? makePackage();
  const records = new Map([[pkg.packageId, pkg]]);
  return {
    env: {
      STORAGE: env.STORAGE,
      RIPGIT: {} as Fetcher,
      LOADER: { get() { throw new Error("LOADER should not be used in pkg shell tests"); } },
    } as unknown as Env,
    auth: null as never,
    caps: null as never,
    config: {
      get(key: string) {
        if (key === "config/server/name") return "gsv";
        if (key === "config/server/version") return "0.1.1";
        return null;
      },
    } as never,
    devices: null as never,
    procs: {
      getMounts() {
        return (options?.mounts ?? []).map((mount) => ({
          kind: "ripgit-source",
          mountPath: mount.mountPath,
          packageId: mount.packageId,
          repo: pkg.manifest.source.repo,
          ref: pkg.manifest.source.ref,
          resolvedCommit: pkg.manifest.source.resolvedCommit ?? null,
          subdir: mount.mountPath === "/src/package" ? pkg.manifest.source.subdir : ".",
        }));
      },
      ...(options?.procs ?? {}),
    } as never,
    workspaces: null as never,
    packages: {
      list() {
        return [...records.values()];
      },
      resolve(packageId: string) {
        return records.get(packageId) ?? null;
      },
      get(packageId: string) {
        return records.get(packageId) ?? null;
      },
      setEnabled(packageId: string, enabled: boolean) {
        const existing = records.get(packageId);
        if (!existing) return null;
        const updated = { ...existing, enabled, updatedAt: existing.updatedAt + 1 };
        records.set(packageId, updated);
        return updated;
      },
      setReviewed(packageId: string, reviewedAt: number) {
        const existing = records.get(packageId);
        if (!existing) return null;
        const updated = { ...existing, reviewedAt, reviewRequired: true, updatedAt: existing.updatedAt + 1 };
        records.set(packageId, updated);
        return updated;
      },
    } as never,
    adapters: null as never,
    runRoutes: null as never,
    schedules: options?.schedules,
    connection: null as never,
    identity: {
      role: "user",
      process: IDENTITY,
      capabilities: options?.capabilities ?? ["pkg.list", "repo.refs", "repo.log"],
    },
    processId: "task:pkg",
    serverVersion: "0.1.1",
    getAppRunner: options?.getAppRunner,
    scheduleScheduleWake: options?.scheduleScheduleWake,
  } as KernelContext;
}

describe("pkg shell command", () => {
  it("shows codemode command usage", async () => {
    const result = await handleShellExec(
      { input: "codemode --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("codemode <script.js>");
    expect(result.stderr).toBe("");
  });

  it("shows proc command usage", async () => {
    const result = await handleShellExec(
      { input: "proc --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("proc self");
    expect(result.stdout).toContain("proc send <pid>");
    expect(result.stdout).toContain("proc call <pid>");
    expect(result.stderr).toBe("");
  });

  it("exposes the current GSV process id to shell commands", async () => {
    const result = await handleShellExec(
      { input: "printf \"$GSV_PID\\n\" && proc self" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("task:pkg\ntask:pkg\n");
    expect(result.stderr).toBe("");
  });

  it("shows sched command usage", async () => {
    const result = await handleShellExec(
      { input: "sched --help" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("sched add --name NAME");
    expect(result.stdout).toContain("sched run <id>");
    expect(result.stderr).toBe("");
  });

  it("creates a process-spawn schedule from the sched command", async () => {
    const wake = vi.fn(async () => "wake-1");
    const setWakeScheduleId = vi.fn();
    const create = vi.fn((input) => ({
      id: "sched-1",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.afterMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));

    const result = await handleShellExec(
      { input: "sched add --name \"quick check\" --after 30s --profile cron \"Run the quick check.\"" },
      makeContext({
        capabilities: ["sched.add"],
        schedules: {
          create,
          setWakeScheduleId,
        } as unknown as KernelContext["schedules"],
        scheduleScheduleWake: wake,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("schedule_id=sched-1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerUid: IDENTITY.uid,
      name: "quick check",
      expression: { kind: "after", afterMs: 30_000 },
      target: {
        kind: "process.spawn",
        profile: "cron",
        prompt: "Run the quick check.",
      },
    }));
    expect(wake).toHaveBeenCalledWith("sched-1", expect.any(Number));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-1", "wake-1");
  });

  it("creates a process-event schedule from the sched command", async () => {
    const wake = vi.fn(async () => "wake-1");
    const setWakeScheduleId = vi.fn();
    const create = vi.fn((input) => ({
      id: "sched-2",
      ownerUid: input.ownerUid,
      creator: input.creator,
      runAs: input.runAs,
      name: input.name,
      enabled: input.enabled,
      expression: input.expression,
      target: input.target,
      overlapPolicy: "skip",
      createdAtMs: input.now,
      updatedAtMs: input.now,
      state: {
        nextRunAtMs: input.now + input.expression.everyMs,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }));

    const result = await handleShellExec(
      { input: "sched add --name \"ops pulse\" --every 15m --pid init:1000 --conversation ops --message \"Run pulse.\"" },
      makeContext({
        capabilities: ["sched.add"],
        procs: {
          get: vi.fn(() => ({
            uid: IDENTITY.uid,
            workspaceId: null,
          })),
        } as Partial<KernelContext["procs"]>,
        schedules: {
          create,
          setWakeScheduleId,
        } as unknown as KernelContext["schedules"],
        scheduleScheduleWake: wake,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("schedule_id=sched-2");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "ops pulse",
      expression: { kind: "every", everyMs: 900_000 },
      target: {
        kind: "process.event",
        pid: "init:1000",
        conversationId: "ops",
        message: "Run pulse.",
      },
    }));
    expect(setWakeScheduleId).toHaveBeenCalledWith("sched-2", "wake-1");
  });

  it("shows schedule last status and error in sched list", async () => {
    const result = await handleShellExec(
      { input: "sched list --all" },
      makeContext({
        capabilities: ["sched.list"],
        schedules: {
          list: vi.fn(() => ({
            count: 1,
            records: [{
              id: "sched-err",
              ownerUid: IDENTITY.uid,
              creator: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:pkg" },
              runAs: { kind: "process", uid: IDENTITY.uid, username: IDENTITY.username, pid: "task:pkg" },
              name: "broken target",
              enabled: false,
              expression: { kind: "after", afterMs: 30_000 },
              target: { kind: "process.event", pid: "missing", message: "Run." },
              overlapPolicy: "skip",
              createdAtMs: 1,
              updatedAtMs: 2,
              state: {
                nextRunAtMs: null,
                runningAtMs: null,
                lastRunAtMs: 3,
                lastStatus: "error",
                lastError: "Process not found: missing",
                lastDurationMs: 4,
                runCount: 1,
              },
            }],
          })),
        } as unknown as KernelContext["schedules"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("LAST\tERROR");
    expect(result.stdout).toContain("error\tProcess not found: missing");
  });

  it("defaults to the mounted package for manifest inspection", async () => {
    const result = await handleShellExec(
      { input: "pkg manifest", cwd: "/src/package" },
      makeContext({ mounts: [{ mountPath: "/src/package", packageId: "import:root/pkg-test:." }] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('"name": "ascii-starfield"');
    expect(result.stderr).toBe("");
  });

  it("shows review status in pkg list output", async () => {
    const result = await handleShellExec(
      { input: "pkg list" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("ascii-starfield");
    expect(result.stdout).toContain("pending");
  });

  it("enables an approved package through pkg enable", async () => {
    const result = await handleShellExec(
      { input: "pkg enable" },
      makeContext({
        capabilities: ["pkg.install"],
        mounts: [{ mountPath: "/src/package", packageId: "import:root/pkg-test:." }],
        pkg: makePackage({
          scope: { kind: "user", uid: 1000 },
          reviewedAt: 100,
          reviewRequired: true,
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("enabled ascii-starfield");
    expect(result.stderr).toBe("");
  });

  it("runs package commands through app runner", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "hello from runner\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "hello-world alpha beta" },
      makeContext({
        pkg: makePackage({
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            entrypoints: [
              {
                name: "Hello World",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "hello-world",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hello from runner");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.kind).toBe("ensure");
    expect(calls[1]).toEqual({
      kind: "run",
      value: {
        commandName: "hello-world",
        args: ["alpha", "beta"],
        cwd: "/home/sam",
        uid: 1000,
        gid: 1000,
        username: "sam",
      },
    });
  });

  it("allows the builtin Wiki package to provide the wiki command", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "wiki package command\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "wiki search auth" },
      makeContext({
        pkg: makePackage({
          packageId: "builtin:wiki@0.1.0",
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            name: "wiki",
            source: {
              repo: "root/gsv",
              ref: "main",
              subdir: "builtin-packages/wiki",
              resolvedCommit: "abc123",
            },
            entrypoints: [
              {
                name: "wiki",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "wiki",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("wiki package command");
    expect(calls[1]).toEqual({
      kind: "run",
      value: {
        commandName: "wiki",
        args: ["search", "auth"],
        cwd: "/home/sam",
        uid: 1000,
        gid: 1000,
        username: "sam",
      },
    });
  });

  it("does not allow non-builtin packages to shadow the wiki command", async () => {
    const calls: Array<{ kind: "ensure" | "run"; value: unknown }> = [];
    const runner = {
      async ensureRuntime(input: unknown) {
        calls.push({ kind: "ensure", value: input });
      },
      async runCommand(input: unknown) {
        calls.push({ kind: "run", value: input });
        return {
          stdout: "shadowed wiki command\n",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const result = await handleShellExec(
      { input: "wiki search auth" },
      makeContext({
        pkg: makePackage({
          enabled: true,
          reviewRequired: false,
          manifest: {
            ...makePackage().manifest,
            name: "wiki",
            entrypoints: [
              {
                name: "wiki",
                kind: "command",
                module: "index.js",
                exportName: "GsvCommandEntrypoint",
                command: "wiki",
              },
            ],
          },
        }),
        getAppRunner() {
          return runner;
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("shadowed wiki command");
    expect(calls).toHaveLength(0);
  });
});
