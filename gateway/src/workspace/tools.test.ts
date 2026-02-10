import { describe, expect, it } from "vitest";
import { executeWorkspaceTool, WORKSPACE_TOOLS } from "./tools";

type StoredEntry = {
  content: string;
  uploaded: Date;
};

class MockBucket {
  private readonly entries = new Map<string, StoredEntry>();

  seed(key: string, content: string) {
    this.entries.set(key, { content, uploaded: new Date("2026-01-01T00:00:00.000Z") });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    return {
      key,
      size: entry.content.length,
      uploaded: entry.uploaded,
      text: async () => entry.content,
    };
  }

  async put(key: string, content: string) {
    this.entries.set(key, { content, uploaded: new Date("2026-01-01T00:00:00.000Z") });
  }

  async head(key: string) {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    return {
      key,
      size: entry.content.length,
      uploaded: entry.uploaded,
    };
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  async list(opts: { prefix?: string; delimiter?: string }) {
    const prefix = opts.prefix || "";
    const delimiter = opts.delimiter;
    const objects: Array<{ key: string }> = [];
    const delimitedPrefixes = new Set<string>();

    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const remainder = key.slice(prefix.length);
      if (!remainder) {
        continue;
      }

      if (!delimiter) {
        objects.push({ key });
        continue;
      }

      const delimiterIndex = remainder.indexOf(delimiter);
      if (delimiterIndex === -1) {
        objects.push({ key });
        continue;
      }

      delimitedPrefixes.add(prefix + remainder.slice(0, delimiterIndex + 1));
    }

    return {
      objects,
      delimitedPrefixes: Array.from(delimitedPrefixes),
    };
  }
}

describe("workspace tools: global skills routing", () => {
  it("reads a global skill when no agent override exists", async () => {
    const bucket = new MockBucket();
    bucket.seed("skills/demo/SKILL.md", "global demo");

    const result = await executeWorkspaceTool(
      bucket as unknown as R2Bucket,
      "main",
      WORKSPACE_TOOLS.READ_FILE,
      { path: "skills/demo/SKILL.md" },
    );

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const payload = result.result as Record<string, unknown>;
    expect(payload.content).toBe("global demo");
    expect(payload.resolvedSource).toBe("global");
    expect(payload.resolvedPath).toBe("skills/demo/SKILL.md");
  });

  it("prefers an agent skill override over global skill content", async () => {
    const bucket = new MockBucket();
    bucket.seed("skills/demo/SKILL.md", "global demo");
    bucket.seed("agents/main/skills/demo/SKILL.md", "agent demo");

    const result = await executeWorkspaceTool(
      bucket as unknown as R2Bucket,
      "main",
      WORKSPACE_TOOLS.READ_FILE,
      { path: "skills/demo/SKILL.md" },
    );

    expect(result.ok).toBe(true);

    const payload = result.result as Record<string, unknown>;
    expect(payload.content).toBe("agent demo");
    expect(payload.resolvedSource).toBe("agent");
    expect(payload.resolvedPath).toBe("agents/main/skills/demo/SKILL.md");
  });

  it("keeps writes scoped to agent workspace for skills paths", async () => {
    const bucket = new MockBucket();

    const result = await executeWorkspaceTool(
      bucket as unknown as R2Bucket,
      "main",
      WORKSPACE_TOOLS.WRITE_FILE,
      { path: "skills/demo/NOTES.md", content: "note" },
    );

    expect(result.ok).toBe(true);
    expect(bucket.has("agents/main/skills/demo/NOTES.md")).toBe(true);
    expect(bucket.has("skills/demo/NOTES.md")).toBe(false);
  });

  it("lists virtual skills directory using merged agent/global view", async () => {
    const bucket = new MockBucket();
    bucket.seed("agents/main/skills/demo/SKILL.md", "agent demo");
    bucket.seed("skills/demo/SKILL.md", "global demo");
    bucket.seed("skills/ops/SKILL.md", "global ops");

    const result = await executeWorkspaceTool(
      bucket as unknown as R2Bucket,
      "main",
      WORKSPACE_TOOLS.LIST_FILES,
      { path: "skills/" },
    );

    expect(result.ok).toBe(true);
    const payload = result.result as { directories: string[]; files: string[] };
    expect(payload.files).toEqual([]);
    expect(payload.directories).toContain("skills/demo/");
    expect(payload.directories).toContain("skills/ops/");
  });

  it("deduplicates files when listing a specific skill directory", async () => {
    const bucket = new MockBucket();
    bucket.seed("agents/main/skills/demo/SKILL.md", "agent demo");
    bucket.seed("skills/demo/SKILL.md", "global demo");

    const result = await executeWorkspaceTool(
      bucket as unknown as R2Bucket,
      "main",
      WORKSPACE_TOOLS.LIST_FILES,
      { path: "skills/demo" },
    );

    expect(result.ok).toBe(true);
    const payload = result.result as { directories: string[]; files: string[] };
    expect(payload.directories).toEqual([]);
    expect(payload.files).toEqual(["skills/demo/SKILL.md"]);
  });
});
