import { describe, expect, it } from "vitest";
import type { ChatProcessSummary } from "../../chat/domain/processes";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import {
  resolveChatProcessTargets,
  resolveChatViewerUid,
  selectPersonalChatProcess,
  selectWorkSessionProcess,
} from "./chatProcessSelection";

function process(
  pid: string,
  input: Partial<ChatProcessSummary> = {},
): ChatProcessSummary {
  return {
    pid,
    uid: 1000,
    username: "aria",
    personal: false,
    interactive: true,
    parentPid: null,
    state: "idle",
    runState: "idle",
    activeRunId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: pid,
    title: pid,
    createdAt: 1,
    cwd: "/home/aria",
    ...input,
  };
}

function account(
  uid: number,
  username: string,
  relation: ConsoleAccount["relation"],
): ConsoleAccount {
  return {
    uid,
    username,
    displayName: username,
    relation,
    runnable: true,
    gecos: "",
    capabilities: [],
  };
}

describe("chat process selection", () => {
  it("defaults only to the canonical personal process", () => {
    const personal = process("personal", { personal: true, createdAt: 5 });
    const newerWork = process("newer-work", { createdAt: 50 });

    expect(selectPersonalChatProcess([newerWork, personal], 1000)?.pid).toBe("personal");
  });

  it("keeps a valid preferred personal pid and rejects a preferred work pid", () => {
    const personal = process("personal", { personal: true, lastActiveAt: 10 });
    const work = process("work", { lastActiveAt: 30 });

    expect(selectPersonalChatProcess([work, personal], 1000, personal.pid)?.pid).toBe(personal.pid);
    expect(selectPersonalChatProcess([work, personal], 1000, work.pid)?.pid).toBe(personal.pid);
  });

  it("fails closed instead of choosing between duplicate personal markers", () => {
    const first = process("personal-a", { personal: true, lastActiveAt: 10 });
    const second = process("personal-b", { personal: true, lastActiveAt: 20 });

    expect(selectPersonalChatProcess([second, first], 1000, first.pid)).toBeNull();
  });

  it("returns no home process when the canonical marker is absent", () => {
    expect(selectPersonalChatProcess([process("work")], 1000)).toBeNull();
  });

  it("does not let root adopt either human's personal process", () => {
    const accounts = [
      account(0, "root", "self"),
      account(1000, "alice", "human"),
      account(2000, "bob", "human"),
    ];
    const ownerUid = resolveChatViewerUid(accounts, "root");
    const alicePersonal = process("alice-personal", {
      uid: 1000,
      username: "alice-agent",
      personal: true,
      lastActiveAt: 10,
    });
    const bobPersonal = process("bob-personal", {
      uid: 2000,
      username: "bob-agent",
      personal: true,
      lastActiveAt: 20,
    });

    expect(ownerUid).toBe(0);
    expect(selectPersonalChatProcess([bobPersonal, alicePersonal], ownerUid)).toBeNull();
  });

  it("falls back to the session username and fails closed without a viewer", () => {
    const accounts = [
      account(1000, "alice", "human"),
      account(2000, "bob", "human"),
    ];

    expect(resolveChatViewerUid(accounts, "bob")).toBe(2000);
    expect(resolveChatViewerUid(accounts, "unknown")).toBeNull();
    expect(selectPersonalChatProcess([process("personal", { personal: true })], null)).toBeNull();
  });

  it("fails closed when cached self data disagrees with the active session", () => {
    const accounts = [
      account(1000, "alice", "self"),
      account(2000, "bob", "human"),
    ];

    expect(resolveChatViewerUid(accounts, "bob")).toBeNull();
  });

  it("resolves an explicit non-personal process only as a work session", () => {
    const home = process("home", { personal: true });
    const work = process("work");

    expect(selectWorkSessionProcess([home, work], work.pid, 1000)?.pid).toBe(work.pid);
    expect(selectWorkSessionProcess([home, work], home.pid, 1000)).toBeNull();
  });

  it("rejects listed and pending work owned by another viewer", () => {
    const foreignListed = process("foreign-listed", { uid: 2000 });
    const foreignPending = process("foreign-pending", { uid: 2000 });

    expect(selectWorkSessionProcess([foreignListed], foreignListed.pid, 1000)).toBeNull();
    expect(selectWorkSessionProcess([], foreignPending.pid, 1000, foreignPending)).toBeNull();
    expect(resolveChatProcessTargets({
      ownerUid: 1000,
      pendingProcess: foreignPending,
      processes: [foreignListed],
      workSessionPid: foreignPending.pid,
    })).toMatchObject({
      activeProcess: null,
      workSessionActive: false,
      workSessionProcess: null,
    });
  });

  it("rejects an unknown or stale process id as a Work session", () => {
    const home = process("home", { personal: true });
    const targets = resolveChatProcessTargets({
      ownerUid: 1000,
      processes: [home],
      personalPid: home.pid,
      workSessionPid: "missing-work",
    });

    expect(targets).toMatchObject({
      activeProcess: home,
      targetedProcess: null,
      workSessionActive: false,
      workSessionProcess: null,
    });
  });

  it("allows root to open its own existing process only as work", () => {
    const rootWork = process("root-work", { uid: 0, username: "root" });
    const targets = resolveChatProcessTargets({
      ownerUid: 0,
      processes: [rootWork],
      workSessionPid: rootWork.pid,
    });

    expect(targets.personalProcess).toBeNull();
    expect(targets.activeProcess).toBe(rootWork);
    expect(targets.workSessionActive).toBe(true);
  });

  it("keeps the personal target stored while a temporary work session is active", () => {
    const home = process("home", { personal: true });
    const work = process("work");
    const duringWork = resolveChatProcessTargets({
      ownerUid: 1000,
      processes: [work, home],
      personalPid: home.pid,
      workSessionPid: work.pid,
    });
    const afterWork = resolveChatProcessTargets({
      ownerUid: 1000,
      processes: [work, home],
      personalPid: home.pid,
      workSessionPid: null,
    });

    expect(duringWork.personalProcess?.pid).toBe(home.pid);
    expect(duringWork.activeProcess?.pid).toBe(work.pid);
    expect(duringWork.workSessionActive).toBe(true);
    expect(afterWork.activeProcess?.pid).toBe(home.pid);
  });

  it("opens newly spawned pending work without adopting it as personal", () => {
    const home = process("home", { personal: true });
    const pendingWork = process("new-work");
    const targets = resolveChatProcessTargets({
      ownerUid: 1000,
      processes: [home],
      pendingProcess: pendingWork,
      personalPid: home.pid,
      workSessionPid: pendingWork.pid,
    });

    expect(targets.personalProcess?.pid).toBe(home.pid);
    expect(targets.activeProcess?.pid).toBe(pendingWork.pid);
    expect(targets.workSessionActive).toBe(true);
  });
});
