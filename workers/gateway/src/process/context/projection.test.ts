import { describe, expect, it } from "vitest";
import {
  contextProjectionFromManifest,
  contextProjectionsEqual,
  createContextProjection,
} from "./projection";

describe("context epoch projection", () => {
  it("normalizes prompt-relevant Kernel state into a deterministic snapshot", () => {
    const projection = createContextProjection({
      targets: [
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
      targets: [],
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

  it("retains the last observed skills when catalog refresh is unavailable", () => {
    const fallback = {
      mode: "summary" as const,
      entries: [{ id: "research", description: "Gather sources" }],
    };
    const projection = createContextProjection({
      targets: [],
      mcpServers: ["Calendar"],
      system: { timezone: "UTC" },
      skillIndexMode: "summary",
    }, new Date("2026-08-28T12:00:00Z"), { skills: fallback, targets: [] });

    expect(projection.mcpServers).toEqual(["Calendar"]);
    expect(projection.skills).toEqual(fallback);
    expect(projection.skills).not.toBe(fallback);
    expect(projection.skills.entries[0]).not.toBe(fallback.entries[0]);
  });

  it("retains targets through failed discovery and recovery but accepts a confirmed removal", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    const snapshot = {
      targets: [{ id: "slack-target:workspace", implements: ["shell.exec"] }],
      mcpServers: ["Search"],
      system: { timezone: "UTC" },
      skillIndexMode: "off" as const,
    };
    const initial = createContextProjection(snapshot, now);
    const unavailable = createContextProjection({ ...snapshot, targets: undefined }, now, initial);
    const recovered = createContextProjection(snapshot, now, unavailable);
    const removed = createContextProjection({ ...snapshot, targets: [] }, now, recovered);

    expect(unavailable).toEqual(initial);
    expect(unavailable.targets).not.toBe(initial.targets);
    expect(recovered).toEqual(initial);
    expect(removed.targets).toEqual([]);
    expect(contextProjectionsEqual(recovered, removed)).toBe(false);

    const otherChanges = createContextProjection({
      ...snapshot,
      targets: undefined,
      mcpServers: ["Calendar"],
    }, new Date("2026-08-29T12:00:00Z"), initial);
    expect(otherChanges.targets).toEqual(initial.targets);
    expect(otherChanges.mcpServers).toEqual(["Calendar"]);
    expect(otherChanges.runtime.date).toBe("2026-08-29");
  });

  it("starts an unavailable target catalog without inventing a prior target", () => {
    const projection = createContextProjection({
      mcpServers: [],
      system: { timezone: "UTC" },
      skillIndexMode: "off",
    });
    expect(projection.targets).toEqual([]);
  });
});
