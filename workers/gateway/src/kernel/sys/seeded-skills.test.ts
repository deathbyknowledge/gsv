import { describe, expect, it, vi } from "vitest";
import type { RipgitApplyOp, RipgitPathResult, RipgitRepoRef, RipgitTreeEntry } from "../../fs";
import { readSystemSkillPath } from "./builtin-skills";
import { seededSkillCleanupOps } from "./seeded-skills";

const HOME: RipgitRepoRef = { owner: "sam", repo: "home", branch: "head1" };

function file(content: string): RipgitPathResult {
  const bytes = new TextEncoder().encode(content);
  return { kind: "file", bytes, size: bytes.length };
}

function tree(...entries: Array<[string, RipgitTreeEntry["type"]]>): RipgitPathResult {
  return { kind: "tree", entries: entries.map(([name, type]) => ({ name, type, mode: type === "tree" ? "040000" : "100644", hash: name })) };
}

function builtin(name: string): string {
  const skill = readSystemSkillPath(`/sys/skills.d/${name}/SKILL.md`);
  if (skill.kind !== "file") throw new Error(`missing built-in ${name}`);
  return skill.content;
}

function client(paths: Record<string, RipgitPathResult>) {
  const readPath = vi.fn(async (_repo: RipgitRepoRef, path: string): Promise<RipgitPathResult> => paths[path] ?? { kind: "missing" });
  return { client: { readPath }, readPath };
}

describe("seededSkillCleanupOps", () => {
  it("deletes copies of built-in skills that nobody edited", async () => {
    const { client: ripgit } = client({
      "skills.d": tree([".dir", "blob"], ["memory", "tree"], ["browser-target", "tree"], ["daily-review", "tree"]),
      "skills.d/memory": tree(["SKILL.md", "blob"]),
      "skills.d/memory/SKILL.md": file(builtin("memory")),
      "skills.d/browser-target": tree(["SKILL.md", "blob"]),
      "skills.d/browser-target/SKILL.md": file(builtin("browser-target")),
      "skills.d/daily-review": tree(["SKILL.md", "blob"]),
    });

    expect(await seededSkillCleanupOps(ripgit, HOME)).toEqual<RipgitApplyOp[]>([
      { type: "delete", path: "skills.d/browser-target", recursive: true },
      { type: "delete", path: "skills.d/memory", recursive: true },
    ]);
  });

  it("keeps an edited copy as the person's own skill under a new name", async () => {
    const edited = builtin("memory").replace("# ", "# My ");
    const { client: ripgit } = client({
      "skills.d": tree(["memory", "tree"], ["memory-custom", "tree"], ["contacts", "tree"]),
      "skills.d/memory": tree(["SKILL.md", "blob"]),
      "skills.d/memory/SKILL.md": file(edited),
      "skills.d/contacts": tree(["SKILL.md", "blob"], ["people.md", "blob"]),
      "skills.d/contacts/SKILL.md": file(builtin("contacts")),
    });

    const ops = await seededSkillCleanupOps(ripgit, HOME);

    expect(ops).toEqual<RipgitApplyOp[]>([
      // An untouched SKILL.md beside the person's own files is still theirs to keep.
      { type: "move", from: "skills.d/contacts", to: "skills.d/contacts-custom" },
      { type: "put", path: "skills.d/contacts-custom/SKILL.md", contentBytes: expect.any(Array) },
      { type: "move", from: "skills.d/memory", to: "skills.d/memory-custom-2" },
      { type: "put", path: "skills.d/memory-custom-2/SKILL.md", contentBytes: expect.any(Array) },
    ]);
    const renamed = new TextDecoder().decode(new Uint8Array(ops[3]?.type === "put" ? ops[3].contentBytes : []));
    expect(renamed).toBe(edited.replace(/^name: memory$/m, "name: memory-custom-2"));
  });

  it("has nothing to do in a home without seeded copies", async () => {
    const { client: ripgit, readPath } = client({
      "skills.d": tree([".dir", "blob"], ["daily-review", "tree"], ["notes.md", "blob"]),
    });

    expect(await seededSkillCleanupOps(ripgit, HOME)).toEqual([]);
    expect(readPath).toHaveBeenCalledTimes(1);
    expect(await seededSkillCleanupOps(client({}).client, HOME)).toEqual([]);
  });
});
