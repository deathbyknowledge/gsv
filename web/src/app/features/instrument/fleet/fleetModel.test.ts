import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../../chat/domain/transcript";
import type { ConsoleProcess, ConsoleTarget } from "../../gsv-console/domain/consoleModels";
import {
  CLOUD_TARGET_ID,
  describeToolCall,
  ledgerFromRows,
  mergeLedger,
  orderPlaces,
  orderProcesses,
  planetVariantForKind,
  recentlyTouched,
  relativeTime,
  rowKeys,
  runsTodayByPlace,
  targetFromToolArgs,
  shortPid,
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

function toolRow(overrides: Partial<ChatTranscriptRow>): ChatTranscriptRow {
  return { id: "r1", text: "", time: "", timestamp: 5_000, role: "tool", toolSyscall: "shell.exec", ...overrides };
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
  it("reads the place from the target argument and falls back to the cloud", () => {
    expect(targetFromToolArgs({ target: "laptop", input: "ls" })).toBe("laptop");
    expect(targetFromToolArgs({ path: "~/notes" })).toBe(CLOUD_TARGET_ID);
    expect(targetFromToolArgs(undefined)).toBe(CLOUD_TARGET_ID);
  });

  it("describes a call by the argument a person recognizes", () => {
    expect(describeToolCall("shell.exec", { input: "ls -la", target: "laptop" })).toBe("ls -la");
    expect(describeToolCall("fs.read", { path: "~/Downloads" })).toBe("~/Downloads");
    expect(describeToolCall("ai.text.generate", { prompt: "x" })).toBe("ai.text.generate");
  });

  it("turns tool rows into lines and skips prose", () => {
    const lines = ledgerFromRows(
      [
        toolRow({ id: "a", toolArgs: { input: "ls", target: "laptop" }, toolOutcome: "completed" }),
        { id: "b", text: "hello", time: "", timestamp: 6_000, role: "assistant" },
        toolRow({ id: "c", toolSyscall: "fs.write", toolArgs: { path: "~/x.txt" }, status: "error" }),
      ],
      "42",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ place: "laptop", what: "ls", outcome: "completed", processId: "42" });
    expect(lines[1]).toMatchObject({ place: CLOUD_TARGET_ID, syscall: "fs.write", outcome: "failed" });
  });

  it("merges newest first and caps", () => {
    const a = ledgerFromRows([toolRow({ id: "1", timestamp: 100 }), toolRow({ id: "2", timestamp: 300 })], "1");
    const b = ledgerFromRows([toolRow({ id: "3", timestamp: 200 }), toolRow({ id: "4", timestamp: null })], "2");
    const merged = mergeLedger([a, b], 3);
    expect(merged.map((line) => line.timestamp)).toEqual([300, 200, 100]);
  });

  it("counts today's runs per place and lists touched files once", () => {
    const now = new Date(2026, 8, 5, 20, 0, 0).getTime();
    const today = new Date(2026, 8, 5, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 8, 4, 9, 0, 0).getTime();
    const lines = ledgerFromRows(
      [
        toolRow({ id: "1", timestamp: today, toolSyscall: "fs.read", toolArgs: { path: "~/a", target: "laptop" } }),
        toolRow({ id: "2", timestamp: today, toolSyscall: "fs.read", toolArgs: { path: "~/a", target: "laptop" } }),
        toolRow({ id: "3", timestamp: yesterday, toolSyscall: "fs.write", toolArgs: { path: "~/b" } }),
      ],
      "1",
    );
    expect(runsTodayByPlace(lines, now).get("laptop")).toBe(2);
    expect(runsTodayByPlace(lines, now).get(CLOUD_TARGET_ID)).toBeUndefined();
    expect(recentlyTouched(lines, 5).map((line) => line.what)).toEqual(["~/a", "~/b"]);
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
