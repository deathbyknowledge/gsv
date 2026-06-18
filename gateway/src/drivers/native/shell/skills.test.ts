import { describe, expect, it } from "vitest";
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
});

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
