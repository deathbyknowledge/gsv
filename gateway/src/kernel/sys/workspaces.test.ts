import { describe, expect, it } from "vitest";
import type { KernelContext } from "../context";
import { handleSysWorkspaceList } from "./workspaces";

type WorkspaceRow = {
  workspaceId: string;
  ownerUid: number;
  label: string | null;
  kind: "thread" | "app" | "shared";
  state: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  defaultBranch: string;
  headCommit: string | null;
  metaJson: string | null;
};

type ProcessRow = {
  processId: string;
  uid: number;
  workspaceId: string | null;
  state: "running" | "paused" | "killed";
  label: string | null;
  cwd: string;
  createdAt: number;
};

function makeContext(
  uid: number,
  workspaces: WorkspaceRow[],
  processes: ProcessRow[],
): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    workspaces: {
      list(ownerUid?: number) {
        return typeof ownerUid === "number"
          ? workspaces.filter((workspace) => workspace.ownerUid === ownerUid)
          : workspaces.slice();
      },
    } as unknown as KernelContext["workspaces"],
    procs: {
      list(ownerUid?: number) {
        return typeof ownerUid === "number"
          ? processes.filter((process) => process.uid === ownerUid)
          : processes.slice();
      },
    } as unknown as KernelContext["procs"],
  } as KernelContext;
}

describe("sys.workspace.list", () => {
  const workspaces: WorkspaceRow[] = [
    {
      workspaceId: "ws_alpha",
      ownerUid: 1000,
      label: "alpha",
      kind: "thread",
      state: "active",
      createdAt: 10,
      updatedAt: 30,
      defaultBranch: "main",
      headCommit: null,
      metaJson: null,
    },
    {
      workspaceId: "ws_beta",
      ownerUid: 1000,
      label: "beta",
      kind: "thread",
      state: "active",
      createdAt: 20,
      updatedAt: 20,
      defaultBranch: "main",
      headCommit: null,
      metaJson: null,
    },
    {
      workspaceId: "ws_gamma",
      ownerUid: 1001,
      label: "gamma",
      kind: "app",
      state: "archived",
      createdAt: 15,
      updatedAt: 25,
      defaultBranch: "main",
      headCommit: null,
      metaJson: null,
    },
  ];

  const processes: ProcessRow[] = [
    {
      processId: "task:newer",
      uid: 1000,
      workspaceId: "ws_alpha",
      state: "running",
      label: "alpha live",
      cwd: "/workspaces/ws_alpha",
      createdAt: 40,
    },
    {
      processId: "task:older",
      uid: 1000,
      workspaceId: "ws_alpha",
      state: "running",
      label: "alpha old",
      cwd: "/workspaces/ws_alpha",
      createdAt: 35,
    },
    {
      processId: "task:paused",
      uid: 1000,
      workspaceId: "ws_beta",
      state: "paused",
      label: "beta paused",
      cwd: "/workspaces/ws_beta",
      createdAt: 45,
    },
  ];

  it("lists the caller's workspaces with active process summaries", () => {
    const ctx = makeContext(1000, workspaces, processes);
    const result = handleSysWorkspaceList({ kind: "thread" }, ctx);

    expect(result.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["ws_alpha", "ws_beta"]);
    expect(result.workspaces[0]?.activeProcess?.pid).toBe("task:newer");
    expect(result.workspaces[0]?.processCount).toBe(2);
    expect(result.workspaces[1]?.activeProcess).toBeNull();
    expect(result.workspaces[1]?.processCount).toBe(0);
  });

  it("allows root to inspect another user's workspaces", () => {
    const ctx = makeContext(0, workspaces, processes);
    const result = handleSysWorkspaceList({ uid: 1001 }, ctx);

    expect(result.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["ws_gamma"]);
  });

  it("rejects cross-user listing for non-root callers", () => {
    const ctx = makeContext(1000, workspaces, processes);

    expect(() => handleSysWorkspaceList({ uid: 1001 }, ctx)).toThrow(
      "Permission denied: cannot list workspaces for uid 1001",
    );
  });
});
