import { describe, expect, it } from "vitest";
import {
  contextProjectionFromManifest,
  contextProjectionsEqual,
  createContextProjection,
} from "./projection";

describe("context epoch projection", () => {
  it("normalizes prompt-relevant Kernel state into a deterministic snapshot", () => {
    const projection = createContextProjection({
      devices: [
        {
          id: " node-b ",
          label: "Work\nLaptop",
          description: "Trusted by the user",
          platform: " linux ",
          implements: ["shell.exec", "fs.read", "shell.exec"],
        },
        {
          id: "node-a",
          implements: ["net.fetch"],
        },
      ],
      mcpServers: ["Search", "Calendar", "Search"],
      system: { timezone: "Europe/Amsterdam" },
      skillIndexMode: "summary",
      skillIndex: [{
        id: "research",
        name: "Research",
        description: "Search\nand synthesize.",
        source: { kind: "home", label: " home ", writable: true },
      }],
    }, new Date("2026-08-28T12:00:00Z"));

    expect(projection).toEqual({
      version: 1,
      runtime: { date: "2026-08-28", timezone: "Europe/Amsterdam" },
      targets: [
        { id: "node-a", implements: ["net.fetch"] },
        {
          id: "node-b",
          label: "Work Laptop",
          description: "Trusted by the user",
          platform: "linux",
          implements: ["fs.read", "shell.exec"],
        },
      ],
      mcpServers: ["Calendar", "Search"],
      skills: {
        mode: "summary",
        entries: [{
          id: "research",
          description: "Search and synthesize.",
        }],
      },
    });
    expect(contextProjectionFromManifest({
      version: 2,
      contextProjection: projection,
    })).toEqual(projection);
  });

  it("falls back to UTC and compares normalized snapshots exactly", () => {
    const input = {
      devices: [],
      mcpServers: [],
      system: { timezone: "not/a-timezone" },
      skillIndex: [],
      skillIndexMode: "off" as const,
    };
    const first = createContextProjection(input, new Date("2026-08-28T23:59:59Z"));
    const second = createContextProjection(input, new Date("2026-08-29T00:00:00Z"));

    expect(first.runtime).toEqual({ date: "2026-08-28", timezone: "UTC" });
    expect(contextProjectionsEqual(first, first)).toBe(true);
    expect(contextProjectionsEqual(first, second)).toBe(false);
    expect(contextProjectionFromManifest({ version: 1 })).toBeNull();
  });
});
