import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import {
  handleSysCommandExecute,
  handleSysCommandGet,
  handleSysCommandIssue,
  handleSysCommandList,
  handleSysCommandRevoke,
} from "./sys-command";
import { forwardToProcess, handleProcSpawn } from "./proc-handlers";

vi.mock("./proc-handlers", () => ({
  handleProcSpawn: vi.fn(),
  forwardToProcess: vi.fn(),
}));

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

type FakeCommandStore = {
  issue: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  markClaim: ReturnType<typeof vi.fn>;
  markExecuted: ReturnType<typeof vi.fn>;
  addExecution: ReturnType<typeof vi.fn>;
};

function makeContext(uid: number, commands: FakeCommandStore): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
      },
      capabilities: ["proc.send", "proc.spawn", "sys.command.issue", "sys.command.get", "sys.command.list", "sys.command.revoke", "sys.command.execute", "fs.read", "fs.edit", "shell.exec"],
    },
    commands,
    devices: {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => ({ online: true })),
    },
    procs: {
      get: vi.fn((pid: string) => ({ processId: pid, uid, state: "running" })),
      ensureInit: vi.fn(() => ({ pid: `init:${uid}`, created: false })),
    },
    connection: {
      id: "conn-1",
    },
  } as unknown as KernelContext;
}

describe("sys.command handlers", () => {
  let commands: FakeCommandStore;

  beforeEach(() => {
    commands = {
      issue: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      revoke: vi.fn(() => true),
      markClaim: vi.fn(),
      markExecuted: vi.fn(),
      addExecution: vi.fn(),
    };
    vi.mocked(handleProcSpawn).mockReset();
    vi.mocked(forwardToProcess).mockReset();
  });

  it("issues a command for the caller and returns link helpers", async () => {
    const ctx = makeContext(1000, commands);
    const manifest = {
      version: 1 as const,
      kind: "gsv.command" as const,
      subject: { kind: "issuer" as const },
      execution: {
        process: { kind: "init" as const },
        input: { kind: "message" as const, message: "hello" },
      },
    };

    commands.issue.mockResolvedValue({
      commandId: "cmd-1",
      issuerUid: 1000,
      createdAt: 1,
      manifest,
      digest: { alg: "sha256", value: "abc" },
      revokedAt: null,
      revokedReason: null,
      claimedByUid: null,
      claimCount: 0,
      lastExecutedAt: null,
    });

    const result = await handleSysCommandIssue({ manifest }, ctx);
    expect(commands.issue).toHaveBeenCalledWith(1000, manifest);
    expect(result.url).toBe("/c/cmd-1");
    expect(result.cli).toBe("gsv command run cmd-1");
  });

  it("allows reading a claim command by id before it is claimed", () => {
    const ctx = makeContext(1001, commands);
    commands.get.mockReturnValue({
      commandId: "cmd-claim",
      issuerUid: 1000,
      createdAt: 1,
      manifest: {
        version: 1,
        kind: "gsv.command",
        subject: { kind: "claim" },
        execution: {
          process: { kind: "init" },
          input: { kind: "message", message: "hello" },
        },
      },
      digest: { alg: "sha256", value: "abc" },
      revokedAt: null,
      revokedReason: null,
      claimedByUid: null,
      claimCount: 0,
      lastExecutedAt: null,
    });

    const result = handleSysCommandGet({ commandId: "cmd-claim" }, ctx);
    expect(result.command?.commandId).toBe("cmd-claim");
  });

  it("hides claim commands from normal list results unless the caller issued or claimed them", () => {
    const ctx = makeContext(1001, commands);
    commands.list.mockReturnValue([
      {
        commandId: "claim-public",
        issuerUid: 1000,
        createdAt: 1,
        manifest: {
          version: 1,
          kind: "gsv.command",
          subject: { kind: "claim" },
          execution: {
            process: { kind: "init" },
            input: { kind: "message", message: "hello" },
          },
        },
        digest: { alg: "sha256", value: "a" },
        revokedAt: null,
        revokedReason: null,
        claimedByUid: null,
        claimCount: 0,
        lastExecutedAt: null,
      },
      {
        commandId: "for-me",
        issuerUid: 1000,
        createdAt: 2,
        manifest: {
          version: 1,
          kind: "gsv.command",
          subject: { kind: "uid", uid: 1001 },
          execution: {
            process: { kind: "init" },
            input: { kind: "message", message: "hello" },
          },
        },
        digest: { alg: "sha256", value: "b" },
        revokedAt: null,
        revokedReason: null,
        claimedByUid: null,
        claimCount: 0,
        lastExecutedAt: null,
      },
    ]);

    const result = handleSysCommandList({}, ctx);
    expect(result.commands.map((command) => command.commandId)).toEqual(["for-me"]);
  });

  it("allows only the issuer to revoke a command", () => {
    const ctx = makeContext(1001, commands);
    commands.get.mockReturnValue({
      commandId: "cmd-1",
      issuerUid: 1000,
      createdAt: 1,
      manifest: {
        version: 1,
        kind: "gsv.command",
        subject: { kind: "issuer" },
        execution: {
          process: { kind: "init" },
          input: { kind: "message", message: "hello" },
        },
      },
      digest: { alg: "sha256", value: "abc" },
      revokedAt: null,
      revokedReason: null,
      claimedByUid: null,
      claimCount: 0,
      lastExecutedAt: null,
    });

    expect(() =>
      handleSysCommandRevoke({ commandId: "cmd-1" }, ctx),
    ).toThrow("Permission denied");
  });

  it("executes a claim command by spawning a process and sending the message", async () => {
    const ctx = makeContext(1001, commands);
    commands.get.mockReturnValue({
      commandId: "cmd-claim",
      issuerUid: 1000,
      createdAt: 1,
      manifest: {
        version: 1,
        kind: "gsv.command",
        subject: { kind: "claim", maxClaims: 2 },
        policy: {
          requiredCapabilities: ["fs.read", "shell.exec"],
        },
        execution: {
          process: { kind: "spawn", label: "demo" },
          input: { kind: "message", message: "ship it" },
        },
      },
      digest: { alg: "sha256", value: "abc" },
      revokedAt: null,
      revokedReason: null,
      claimedByUid: null,
      claimCount: 0,
      lastExecutedAt: null,
    });
    vi.mocked(handleProcSpawn).mockResolvedValue({ ok: true, pid: "task-1", label: "demo" });
    vi.mocked(forwardToProcess).mockResolvedValue({
      ok: true,
      status: "started",
      runId: "run-1",
    });

    const result = await handleSysCommandExecute({ commandId: "cmd-claim" }, ctx);
    expect(result).toEqual({
      ok: true,
      commandId: "cmd-claim",
      pid: "task-1",
      runId: "run-1",
      claimedByUid: 1001,
    });
    expect(commands.markClaim).toHaveBeenCalledWith("cmd-claim", 1001);
    expect(commands.markExecuted).toHaveBeenCalledWith("cmd-claim");
    expect(commands.addExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-claim",
        executorUid: 1001,
        pid: "task-1",
        runId: "run-1",
        routeKind: "connection",
      }),
    );
  });
});
