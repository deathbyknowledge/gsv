type KernelTestValue<T = string | number | boolean | null | undefined> = T;

import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import type { RipgitClient, RipgitPathResult } from "../../fs";
import {
  BUILTIN_SKILL_FILES,
  LEGACY_MEMORY_SKILL,
} from "./builtin-skills";
import { seedBuiltinSkillsToHome } from "./skills-seed";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
};

function textFile(content = "custom skill"): RipgitPathResult {
  const bytes = new TextEncoder().encode(content);
  return { kind: "file", bytes, size: bytes.length };
}

function makeClient(files: Map<string, RipgitPathResult>) {
  const readPath = vi.fn(async (_repo: KernelTestValue, path: string): Promise<RipgitPathResult> =>
    files.get(path) ?? { kind: "missing" }
  );
  const apply = vi.fn(async () => ({ head: "home123" }));
  return {
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    client: { readPath, apply } as RipgitClient,
    readPath,
    apply,
  };
}

describe("seedBuiltinSkillsToHome", () => {
  it("adds newly bundled skills to a legacy home without replacing existing skills", async () => {
    const legacyPaths = [
      "browser-target/SKILL.md",
      "gsv-manual/SKILL.md",
      "skill-authoring/SKILL.md",
    ];
    const files = new Map<string, RipgitPathResult>([
      ["skills.d", { kind: "tree", entries: [] }],
      ...legacyPaths.map((path) => [
        `skills.d/${path}`,
        textFile(),
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      ] as const),
    ]);
    const { client, apply } = makeClient(files);

    const result = await seedBuiltinSkillsToHome(client, IDENTITY);

    expect(result).toEqual({ username: "alice", copied: 3, skipped: 3 });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const operations = apply.mock.calls[0]?.[4] as Array<{
      type: string;
      path: string;
      contentBytes: number[];
    }>;
    expect(operations.map((operation) => operation.path)).toEqual([
      "skills.d/image-reading/SKILL.md",
      "skills.d/memory/SKILL.md",
      "skills.d/process-orchestration/SKILL.md",
    ]);
    for (const path of legacyPaths) {
      expect(operations).not.toContainEqual(
        expect.objectContaining({ path: `skills.d/${path}` }),
      );
    }
  });

  it("does nothing when every bundled skill already exists", async () => {
    const files = new Map<string, RipgitPathResult>([
      ["skills.d", { kind: "tree", entries: [] }],
      ...BUILTIN_SKILL_FILES.map((skill) => [
        `skills.d/${skill.path}`,
        textFile(),
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      ] as const),
    ]);
    const { client, readPath, apply } = makeClient(files);

    const result = await seedBuiltinSkillsToHome(client, IDENTITY);

    expect(result).toEqual({
      username: "alice",
      copied: 0,
      skipped: BUILTIN_SKILL_FILES.length,
    });
    expect(readPath).toHaveBeenCalledTimes(BUILTIN_SKILL_FILES.length + 1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves an existing customized file instead of overwriting it", async () => {
    const firstPath = BUILTIN_SKILL_FILES[0].path;
    const existing = textFile("customized browser workflow");
    const { client, apply } = makeClient(new Map([
      ["skills.d", { kind: "tree", entries: [] }],
      [`skills.d/${firstPath}`, existing],
    ]));

    const result = await seedBuiltinSkillsToHome(client, IDENTITY);

    expect(result).toEqual({
      username: "alice",
      copied: BUILTIN_SKILL_FILES.length - 1,
      skipped: 1,
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const operations = apply.mock.calls[0]?.[4] as Array<{ path: string }>;
    expect(operations).not.toContainEqual(
      expect.objectContaining({ path: `skills.d/${firstPath}` }),
    );
  });

  it("upgrades the untouched generated memory skill", async () => {
    const files = new Map<string, RipgitPathResult>([
      ["skills.d", { kind: "tree", entries: [] }],
      ...BUILTIN_SKILL_FILES.map((skill) => [
        `skills.d/${skill.path}`,
        textFile(skill.path === "memory/SKILL.md" ? LEGACY_MEMORY_SKILL : "custom skill"),
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      ] as const),
    ]);
    const { client, apply } = makeClient(files);

    const result = await seedBuiltinSkillsToHome(client, IDENTITY);

    expect(result).toEqual({
      username: "alice",
      copied: 1,
      skipped: BUILTIN_SKILL_FILES.length - 1,
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const operations = apply.mock.calls[0]?.[4] as Array<{
      type: string;
      path: string;
      contentBytes: number[];
    }>;
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      type: "put",
      path: "skills.d/memory/SKILL.md",
    });
    expect(new TextDecoder().decode(new Uint8Array(operations[0]?.contentBytes ?? [])))
      .toContain("human, not to an individual agent");
  });
});
