import { describe, expect, it } from "vitest";
import type { CommandContext } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { buildSkillsCommand } from "./skills";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

describe("skills shell command", () => {
  it("lists top-level skills by default and discloses nested skills on demand", async () => {
    const command = buildSkillsCommand(makeSkillFs({
      "/home/sam/skills.d": ["device-management"],
      "/home/sam/skills.d/device-management": ["SKILL.md", "skills.d"],
      "/home/sam/skills.d/device-management/SKILL.md": skillMarkdown("device-management", "Manage devices."),
      "/home/sam/skills.d/device-management/skills.d": ["adding-devices"],
      "/home/sam/skills.d/device-management/skills.d/adding-devices": ["SKILL.md"],
      "/home/sam/skills.d/device-management/skills.d/adding-devices/SKILL.md": skillMarkdown("adding-devices", "Add devices."),
    }), makeContext(), IDENTITY);

    const topLevel = await command.execute(["list"]);
    expect(topLevel.exitCode).toBe(0);
    expect(topLevel.stdout).toContain("device-management");
    expect(topLevel.stdout).not.toContain("device-management/adding-devices");

    const children = await command.execute(["list", "device-management"]);
    expect(children.exitCode).toBe(0);
    expect(children.stdout).toContain("device-management/adding-devices");

    const search = await command.execute(["search", "Add"]);
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("device-management/adding-devices");

    const tree = await command.execute(["tree", "device-management"]);
    expect(tree.exitCode).toBe(0);
    expect(tree.stdout).toContain("- device-management: Manage devices.");
    expect(tree.stdout).toContain("  - device-management/adding-devices: Add devices.");

    const show = await command.execute(["show", "device-management"]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("Nested skills:");
    expect(show.stdout).toContain("- device-management/adding-devices: Add devices.");
  });

  it("creates and validates a complete home skill from an instruction body", async () => {
    const state = makeMutableSkillFs({
      "/home/sam": [],
      "/home/sam/draft.md": "# Browse Instagram\n\nInspect the connected browser before interacting.\n",
    });
    const command = buildSkillsCommand(state.fs, makeContext(), IDENTITY);

    const created = await run(command, [
      "create",
      "Browse Instagram",
      "--description",
      "Browse Instagram through a connected browser when the user asks to repeat the workflow.",
      "--from",
      "draft.md",
    ]);

    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Created /home/sam/skills.d/browse-instagram/SKILL.md");
    expect(created.stdout).toContain("NEXT: skills show browse-instagram");
    expect(state.entries["/home/sam/skills.d/browse-instagram/SKILL.md"]).toContain([
      "---",
      "name: browse-instagram",
      "description: >",
    ].join("\n"));

    const validated = await run(command, ["validate", "browse-instagram"]);
    expect(validated.exitCode).toBe(0);
    expect(validated.stdout).toContain("Valid skill: /home/sam/skills.d/browse-instagram/SKILL.md");
  });

  it("never overwrites implicitly and requires --replace for intentional updates", async () => {
    const original = skillMarkdown("daily-review", "Run the daily review.") + "Inspect the queue.\n";
    const state = makeMutableSkillFs({
      "/home/sam": ["skills.d"],
      "/home/sam/skills.d": ["daily-review"],
      "/home/sam/skills.d/daily-review": ["SKILL.md"],
      "/home/sam/skills.d/daily-review/SKILL.md": original,
    });
    const command = buildSkillsCommand(state.fs, makeContext(), IDENTITY);

    const refused = await run(command, [
      "create",
      "daily-review",
      "--description",
      "Run the revised daily review.",
    ], "# Daily Review\n\nInspect the revised queue.");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(state.entries["/home/sam/skills.d/daily-review/SKILL.md"]).toBe(original);

    const replaced = await run(command, [
      "create",
      "daily-review",
      "--description",
      "Run the revised daily review.",
      "--replace",
    ], "# Daily Review\n\nInspect the revised queue.");
    expect(replaced.exitCode).toBe(0);
    expect(replaced.stdout).toContain("Replaced /home/sam/skills.d/daily-review/SKILL.md");
    expect(state.entries["/home/sam/skills.d/daily-review/SKILL.md"]).toContain("Inspect the revised queue.");
  });

  it("rejects traversal and incomplete bodies before mutating the filesystem", async () => {
    const state = makeMutableSkillFs({ "/home/sam": [] });
    const command = buildSkillsCommand(state.fs, makeContext(), IDENTITY);

    const traversal = await run(command, [
      "create",
      "../stolen",
      "--description",
      "A reusable workflow.",
    ], "# Workflow\n\nDo the work.");
    expect(traversal.exitCode).toBe(1);
    expect(traversal.stderr).toContain("must not contain path separators or '..'");

    const empty = await run(command, [
      "create",
      "empty-workflow",
      "--description",
      "A reusable workflow.",
    ]);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("workflow instructions are required");

    const nestedFrontmatter = await run(command, [
      "create",
      "nested-frontmatter",
      "--description",
      "A reusable workflow.",
    ], "---\nname: wrong\ndescription: wrong\n---\n\n# Workflow");
    expect(nestedFrontmatter.exitCode).toBe(1);
    expect(nestedFrontmatter.stderr).toContain("must contain only the Markdown instruction body");
    expect(state.writes).toEqual([]);
    expect(state.entries["/home/sam/skills.d"]).toBeUndefined();
  });
});

async function run(
  command: ReturnType<typeof buildSkillsCommand>,
  args: string[],
  stdin = "",
) {
  return command.execute(args, {
    fs: {} as CommandContext["fs"],
    cwd: IDENTITY.cwd,
    env: new Map(),
    stdin,
  } as CommandContext);
}

function makeContext(): KernelContext {
  return {
    packages: {
      list() {
        return [];
      },
    },
  } as unknown as KernelContext;
}

function makeSkillFs(entries: Record<string, string[] | string>): GsvFs {
  return {
    async readdir(path: string): Promise<string[]> {
      const entry = entries[path];
      if (!Array.isArray(entry)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
    async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
      const entry = entries[path];
      if (entry === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return {
        isFile: typeof entry === "string",
        isDirectory: Array.isArray(entry),
      };
    },
    async readFile(path: string): Promise<string> {
      const entry = entries[path];
      if (typeof entry !== "string") {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
  } as unknown as GsvFs;
}

function makeMutableSkillFs(initial: Record<string, string[] | string>): {
  fs: GsvFs;
  entries: Record<string, string[] | string>;
  writes: string[];
} {
  const entries = structuredClone(initial);
  const writes: string[] = [];

  function addDirectory(path: string): void {
    if (entries[path] === undefined) {
      entries[path] = [];
    }
    const parent = parentPath(path);
    if (parent === path) return;
    addDirectory(parent);
    addChild(parent, pathName(path));
  }

  function addChild(parent: string, child: string): void {
    const existing = entries[parent];
    if (!Array.isArray(existing)) {
      throw new Error(`ENOTDIR: ${parent}`);
    }
    if (!existing.includes(child)) {
      existing.push(child);
    }
  }

  const fs = {
    resolvePath(base: string, path: string): string {
      if (path.startsWith("/")) return normalizePath(path);
      return normalizePath(`${base}/${path}`);
    },
    async exists(path: string): Promise<boolean> {
      return entries[path] !== undefined;
    },
    async mkdir(path: string): Promise<void> {
      addDirectory(path);
    },
    async writeFile(path: string, content: string): Promise<void> {
      addDirectory(parentPath(path));
      addChild(parentPath(path), pathName(path));
      entries[path] = content;
      writes.push(path);
    },
    async readdir(path: string): Promise<string[]> {
      const entry = entries[path];
      if (!Array.isArray(entry)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
    async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
      const entry = entries[path];
      if (entry === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return {
        isFile: typeof entry === "string",
        isDirectory: Array.isArray(entry),
      };
    },
    async readFile(path: string): Promise<string> {
      const entry = entries[path];
      if (typeof entry !== "string") {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
  } as unknown as GsvFs;

  return { fs, entries, writes };
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return `/${parts.slice(0, -1).join("/")}` || "/";
}

function pathName(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).at(-1) ?? "";
}

function skillMarkdown(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}
