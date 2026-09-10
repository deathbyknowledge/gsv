import { describe, expect, it } from "vitest";
import {
  buildConsoleOverviewData,
  normalizeAccountsPayload,
  normalizeConfigPayload,
  normalizeProcessesPayload,
  normalizeTargetsPayload,
  summarizeConsoleOverview,
} from "./consoleNormalization";

describe("console normalization", () => {
  it("preserves the canonical personal marker and excludes it from Work counts", () => {
    const data = buildConsoleOverviewData({
      processes: {
        processes: [
          {
            pid: "personal",
            personal: true,
            state: "running",
            activeRunId: "run:personal",
            queuedCount: 2,
            createdAt: 2,
          },
          {
            pid: "work",
            personal: false,
            state: "idle",
            queuedCount: 0,
            createdAt: 1,
          },
        ],
      },
      targets: { targets: [] },
      accounts: { accounts: [] },
      adapters: [],
      mcpServers: { servers: [] },
      config: { entries: [] },
    });

    expect(data.processes.map((process) => ({ pid: process.pid, personal: process.personal }))).toEqual([
      { pid: "personal", personal: true },
      { pid: "work", personal: false },
    ]);
    expect(summarizeConsoleOverview(data)).toMatchObject({
      processes: 1,
      activeProcesses: 0,
      queuedProcesses: 0,
    });
  });

  it("defaults a missing personal marker to false", () => {
    expect(normalizeProcessesPayload({ processes: [{ pid: "legacy-work" }] })[0]?.personal).toBe(false);
  });

  it("keeps a waiting approval visible instead of flattening it into running", () => {
    expect(normalizeProcessesPayload({
      processes: [{ pid: "proc:approval", state: "waiting_hil", activeRunId: "run:approval" }],
    })[0]?.state).toBe("waiting_hil");
  });

  it("keeps model metadata readable while redacting its separate credential", () => {
    const stack = JSON.stringify({
      version: 1,
      models: [{ id: "deep-research", name: "Deep Research", provider: "openai", model: "gpt-5" }],
    });
    const entries = normalizeConfigPayload({
      entries: [
        { key: "users/42/ai/models", value: stack },
        { key: "users/42/ai/models/deep-research/api_key", value: "sk-secret" },
      ],
    });

    expect(entries).toEqual([
      { key: "users/42/ai/models", value: stack, redacted: false },
      { key: "users/42/ai/models/deep-research/api_key", value: "", redacted: true },
    ]);
  });

  it("classifies browser and native device targets", () => {
    expect(normalizeTargetsPayload({
      targets: [
        { targetId: "browser:brave", label: "Brave", platform: "browser-extension", online: true },
        { targetId: "macbook", label: "MacBook", platform: "darwin", online: true, implements: ["net.fetch", "fs.*"] },
      ],
    })).toMatchObject([
      { deviceId: "browser:brave", kind: "browser" },
      { deviceId: "macbook", kind: "native-device", implements: ["fs.*", "net.fetch"] },
    ]);
  });

  it("normalizes resolved account capabilities", () => {
    expect(normalizeAccountsPayload({
      accounts: [{
        uid: 2000,
        username: "scout",
        displayName: "Scout",
        relation: "agent",
        runnable: true,
        capabilities: ["repo.read", "fs.*", "", "shell.*"],
      }],
    })[0]).toMatchObject({
      username: "scout",
      capabilities: ["fs.*", "repo.read", "shell.*"],
    });
  });
});
