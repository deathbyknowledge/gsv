import { describe, expect, it } from "vitest";
import type { ConsoleProcess, ConsoleTarget } from "../../gsv-console/domain/consoleModels";
import {
  CLOUD_TARGET_ID,
  describeToolCall,
  mergeLedger,
  costTodayByProcess,
  modelByProcess,
  orderPlaces,
  orderProcesses,
  planetVariantForKind,
  recentlyTouched,
  relativeTime,
  rowKeys,
  runsTodayByPlace,
  shortPid,
  humanCall,
  ledgerFromSysLines,
} from "./fleetModel";

function target(overrides: Partial<ConsoleTarget>): ConsoleTarget {
  return {
    deviceId: "laptop",
    kind: "native-device",
    ownerUid: 1000,
    ownerUsername: "esteve",
    label: "MacBook 16",
    description: "",
    platform: "darwin",
    version: "0.4.1",
    online: true,
    lastSeenAt: 1_000,
    implements: ["fs.*"],
    ...overrides,
  };
}

function process(overrides: Partial<ConsoleProcess>): ConsoleProcess {
  return {
    pid: "42",
    label: "inbox-triage",
    state: "idle",
    rawState: "idle",
    uid: 1000,
    username: "esteve",
    profile: "agent",
    cwd: "~",
    parentPid: null,
    interactive: false,
    personal: false,
    activeRunId: null,
    queuedCount: 0,
    createdAt: null,
    lastActiveAt: 10,
    ...overrides,
  };
}

type SysLine = Parameters<typeof ledgerFromSysLines>[0][number];

function sysLine(overrides: Partial<SysLine>): SysLine {
  return {
    seq: 1,
    timestamp: 5_000,
    principalKind: "process",
    uid: 1000,
    pid: "p1",
    runId: "r1",
    target: "laptop",
    call: "shell.exec",
    args: JSON.stringify({ input: "ls", target: "laptop" }),
    outcome: "ok",
    durationMs: 10,
    ...overrides,
  };
}

describe("places", () => {
  it("adds the cloud home and orders machines first", () => {
    const places = orderPlaces([target({ deviceId: "browser-1", kind: "browser", label: "Chrome" }), target({})]);
    expect(places.map((place) => place.id)).toEqual(["laptop", CLOUD_TARGET_ID, "browser-1"]);
    expect(places[1].kind).toBe("cloud");
  });

  it("keeps an existing cloud target instead of adding a second one", () => {
    const places = orderPlaces([target({ deviceId: CLOUD_TARGET_ID, kind: "unknown", label: "gsv" })]);
    expect(places).toHaveLength(1);
  });

  it("maps every kind to a planet", () => {
    expect(planetVariantForKind("machine")).toBe("orbit");
    expect(planetVariantForKind("cloud")).toBe("giant");
    expect(planetVariantForKind("browser")).toBe("disc");
    expect(planetVariantForKind("contact")).toBe("crescent");
    expect(planetVariantForKind("unknown")).toBe("moon");
  });
});

describe("processes", () => {
  it("leads with the ship, then the most recently active", () => {
    const ordered = orderProcesses([
      process({ pid: "42", lastActiveAt: 10 }),
      process({ pid: "57", lastActiveAt: 90 }),
      process({ pid: "1", personal: true, lastActiveAt: 1 }),
    ]);
    expect(ordered.map((entry) => entry.pid)).toEqual(["1", "57", "42"]);
  });

  it("lists row keys as places then processes", () => {
    const keys = rowKeys(orderPlaces([target({})]), [process({ pid: "7" })]);
    expect(keys).toEqual(["target:laptop", "target:gsv", "proc:7"]);
  });
});

describe("ledger", () => {
  it("describes a call by the argument a person recognizes", () => {
    expect(describeToolCall("shell.exec", { input: "ls -la", target: "laptop" })).toBe("ls -la");
    expect(describeToolCall("fs.read", { path: "~/Downloads" })).toBe("~/Downloads");
    expect(describeToolCall("ai.text.generate", { prompt: "x" })).toBe("ai.text.generate");
  });

  it("merges newest first and caps", () => {
    const a = ledgerFromSysLines([sysLine({ seq: 1, timestamp: 100 }), sysLine({ seq: 2, timestamp: 300 })]);
    const b = ledgerFromSysLines([sysLine({ seq: 3, timestamp: 200 })]);
    const merged = mergeLedger([a, b], 2);
    expect(merged.map((line) => line.timestamp)).toEqual([300, 200]);
  });

  it("counts today's runs per place and lists touched files once", () => {
    const now = new Date(2026, 8, 5, 20, 0, 0).getTime();
    const today = new Date(2026, 8, 5, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 8, 4, 9, 0, 0).getTime();
    const lines = ledgerFromSysLines([
      sysLine({ seq: 3, timestamp: today, call: "fs.read", args: JSON.stringify({ path: "~/a", target: "laptop" }) }),
      sysLine({ seq: 2, timestamp: today, call: "fs.read", args: JSON.stringify({ path: "~/a", target: "laptop" }) }),
      sysLine({ seq: 1, timestamp: yesterday, call: "fs.write", target: "gsv", args: JSON.stringify({ path: "~/b" }) }),
    ]);
    expect(runsTodayByPlace(lines, now).get("laptop")).toBe(2);
    expect(runsTodayByPlace(lines, now).get(CLOUD_TARGET_ID)).toBeUndefined();
    expect(recentlyTouched(lines, 5).map((line) => line.detail)).toEqual(["~/a", "~/b"]);
  });

  it("sums today's cost and finds the model per process from the ai lines", () => {
    const now = new Date(2026, 8, 5, 20, 0, 0).getTime();
    const today = new Date(2026, 8, 5, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 8, 4, 9, 0, 0).getTime();
    const lines = ledgerFromSysLines([
      sysLine({ seq: 3, timestamp: today, pid: "p1", call: "ai.text.generate", args: JSON.stringify({ model: "gsv/fast" }), costNanoUsd: 1_500_000_000 }),
      sysLine({ seq: 2, timestamp: today, pid: "p1", call: "ai.text.generate", args: JSON.stringify({ model: "gsv/slow" }), costNanoUsd: 500_000_000 }),
      sysLine({ seq: 1, timestamp: yesterday, pid: "p1", call: "ai.text.generate", args: JSON.stringify({ model: "gsv/old" }), costNanoUsd: 9_000_000_000 }),
    ]);
    expect(costTodayByProcess(lines, now).get("p1")).toBeCloseTo(2);
    expect(modelByProcess(lines).get("p1")).toBe("gsv/fast");
  });
});

describe("time", () => {
  it("formats relative times in plain words", () => {
    const now = 1_000_000_000;
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
});

describe("shortPid", () => {
  it("keeps short ids and tails long ones", () => {
    expect(shortPid("42")).toBe("42");
    expect(shortPid("proc-1")).toBe("proc1");
    expect(shortPid("3f9a2c7e-11b2-4c1d-9e0f-a1b2c3d4e5f6")).toBe("d4e5f6");
  });
});

describe("humanCall", () => {
  it("names shell work by its first word", () => {
    expect(humanCall("shell.exec", { input: "message ana <<GSV_MESSAGE\nhello\nGSV_MESSAGE" })).toBe("sent a message");
    expect(humanCall("shell.exec", { input: "ls -la ~/Downloads" })).toBe("looked around");
    expect(humanCall("shell.exec", { input: "cp a b" })).toBe("copied files");
    expect(humanCall("shell.exec", { input: "./deploy.sh" })).toBe("ran a command");
  });
  it("names file and web calls by what they touched", () => {
    expect(humanCall("fs.read", { path: "/home/e/Downloads/invoice-0231.pdf" })).toBe("read invoice-0231.pdf");
    expect(humanCall("fs.search", { query: "invoice" })).toBe("searched for invoice");
    expect(humanCall("net.fetch", { url: "https://api.github.com/repos" })).toBe("fetched api.github.com");
    expect(humanCall("ai.generate", undefined)).toBe("thought about it");
    expect(humanCall("codemode.exec", { code: "const x = 1;\nreturn x;" })).toBe("ran a script");
  });
  it("collapses a heredoc to one line in the detail", () => {
    expect(describeToolCall("shell.exec", { input: "message ana <<GSV_MESSAGE\nhello there\nGSV_MESSAGE" })).toBe("message ana <<GSV_MESSAGE hello there GSV_MESSAGE");
  });
});

describe("ledgerFromSysLines", () => {
  it("draws the kernel's lines from their recorded arguments", () => {
    const lines = ledgerFromSysLines([
      sysLine({ seq: 7, timestamp: 5_000, args: JSON.stringify({ input: "ls -la", target: "laptop" }) }),
      sysLine({ seq: 8, timestamp: 6_000, principalKind: "human", pid: null, runId: null, target: "gsv", call: "fs.read", args: JSON.stringify({ path: "~/notes.md" }), outcome: null, durationMs: null }),
      sysLine({ seq: 9, timestamp: 7_000, call: "codemode.exec", args: '{"code":"const x = 1;\\nconst y = "…' }),
    ]);
    expect(lines[0]).toMatchObject({ id: "sys:7", place: "laptop", what: "looked around", detail: "ls -la", outcome: "completed", processId: "p1" });
    expect(lines[1]).toMatchObject({ id: "sys:8", what: "read notes.md", outcome: "running", processId: "you" });
    // a line cut at the size bound is not JSON any more; it is shown as the text it is
    expect(lines[2]).toMatchObject({ what: "ran a script", detail: '{"code":"const x = 1;\\nconst y = "…' });
  });
});
