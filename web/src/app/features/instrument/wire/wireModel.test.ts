import { describe, expect, it } from "vitest";
import type { ConsoleProcess, ConsoleTarget } from "../../gsv-console/domain/consoleModels";
import type { LedgerLine } from "../fleet/fleetModel";
import { patchProcesses, patchTargets, prependLedger } from "./wireModel";

const target = (deviceId: string, online: boolean): ConsoleTarget => ({
  deviceId,
  kind: "native-device",
  ownerUid: 1000,
  ownerUsername: "e",
  label: deviceId,
  description: "",
  platform: "linux",
  version: "0.5.0",
  online,
  lastSeenAt: 1,
  implements: [],
});

const process = (pid: string): ConsoleProcess => ({
  pid,
  label: pid,
  state: "idle",
  rawState: "idle",
  uid: 1000,
  username: "e",
  profile: "",
  cwd: "~",
  parentPid: null,
  interactive: true,
  personal: pid === "p1",
  activeRunId: null,
  queuedCount: 0,
  createdAt: 1,
  lastActiveAt: 1,
});

describe("patchTargets", () => {
  it("sets a known target's status from the signal and leaves the others alone", () => {
    const patch = patchTargets([target("laptop", false), target("office", true)], { event: "connected", target: { targetId: "laptop", label: "MacBook" } }, 50);
    expect(patch.known).toBe(true);
    expect(patch.next[0]).toMatchObject({ online: true, label: "MacBook", lastSeenAt: 50 });
    expect(patch.next[1]).toBe(patch.next[1]);
  });
  it("reports a target the list has never seen", () => {
    expect(patchTargets([], { event: "connected", target: { targetId: "new" } }, 1).known).toBe(false);
  });
});

describe("patchProcesses", () => {
  it("walks a process through a run", () => {
    const started = patchProcesses([process("p1")], "proc.run.started", { pid: "p1", runId: "r1" }, 10);
    expect(started.next[0]).toMatchObject({ state: "running", activeRunId: "r1", lastActiveAt: 10 });
    const waiting = patchProcesses(started.next, "proc.run.hil.requested", { pid: "p1" }, 11);
    expect(waiting.next[0].state).toBe("waiting_hil");
    const finished = patchProcesses(waiting.next, "proc.run.finished", { pid: "p1", queuedCount: 2 }, 12);
    expect(finished.next[0]).toMatchObject({ state: "queued", activeRunId: null, queuedCount: 2 });
    const idle = patchProcesses(finished.next, "proc.run.finished", { pid: "p1", queuedCount: 0 }, 13);
    expect(idle.next[0].state).toBe("idle");
  });
  it("removes an exited process and reports an unknown one, except on exit", () => {
    expect(patchProcesses([process("p1"), process("p2")], "process.exit", { pid: "p2" }, 1).next.map((entry) => entry.pid)).toEqual(["p1"]);
    expect(patchProcesses([process("p1")], "proc.run.started", { pid: "p9" }, 1).known).toBe(false);
    expect(patchProcesses([process("p1")], "process.exit", { pid: "p9" }, 1).known).toBe(true);
  });
});

describe("prependLedger", () => {
  // SAFETY: prependLedger reads only the id; no other field of a line matters to it.
  const line = (id: string): LedgerLine => ({ id }) as LedgerLine;
  it("puts new lines in front of the first page and skips ones already held", () => {
    const data = { pages: [{ lines: [line("sys:3"), line("sys:2")], nextCursor: "c" }], pageParams: [null] };
    const next = prependLedger(data, [line("sys:5"), line("sys:4"), line("sys:3")]);
    expect(next.pages[0].lines.map((entry) => entry.id)).toEqual(["sys:5", "sys:4", "sys:3", "sys:2"]);
    expect(next.pages[0].nextCursor).toBe("c");
    expect(prependLedger(data, [line("sys:3")])).toBe(data);
  });
});
