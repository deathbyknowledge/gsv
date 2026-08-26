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
      targets: { devices: [] },
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

  it("redacts secrets nested inside model profile config values", () => {
    const [entry] = normalizeConfigPayload({
      entries: [{
        key: "users/42/ai/model_profiles",
        value: JSON.stringify({
          version: 1,
          profiles: [{
            id: "deep-research",
            name: "Deep Research",
            values: {
              "config/ai/provider": "openai",
              "config/ai/model": "gpt-5",
              "config/ai/api_key": "sk-secret",
            },
          }],
        }),
      }],
    });

    expect(entry.redacted).toBe(false);
    expect(entry.value).not.toContain("sk-secret");
    expect(JSON.parse(entry.value)).toMatchObject({
      profiles: [{
        values: {
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-5",
          "config/ai/api_key": "",
        },
      }],
    });
  });

  it("classifies browser and native device targets", () => {
    expect(normalizeTargetsPayload({
      devices: [
        { deviceId: "browser:brave", label: "Brave", platform: "browser-extension", online: true },
        { deviceId: "macbook", label: "MacBook", platform: "darwin", online: true, implements: ["net.fetch", "fs.*"] },
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
