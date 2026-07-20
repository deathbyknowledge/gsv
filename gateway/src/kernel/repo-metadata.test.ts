import { describe, expect, it } from "vitest";
import {
  applyRepoMetadataMutation,
  normalizeRepoMetadataMutation,
  parseRepoMetadataConfigKey,
  selectRepoMetadataProjection,
} from "./repo-metadata";

function makeConfig(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => values.set(key, value),
    delete: (key: string) => values.delete(key),
    values,
  };
}

describe("repository metadata authority", () => {
  it("accepts only the exact operation/capability pairs and normalized targets", () => {
    expect(normalizeRepoMetadataMutation({
      kind: "register",
      call: "repo.apply",
      repo: { owner: "alice", repo: "notes.v2" },
      description: "  Notes  ",
    })).toEqual({
      kind: "register",
      call: "repo.apply",
      repo: { owner: "alice", repo: "notes.v2" },
      description: "Notes",
    });

    expect(() => normalizeRepoMetadataMutation({
      kind: "delete",
      call: "repo.apply",
      repo: { owner: "alice", repo: "notes" },
    })).toThrow("Invalid repository metadata mutation");
    expect(() => normalizeRepoMetadataMutation({
      kind: "visibility",
      call: "repo.visibility.set",
      repo: { owner: "alice/../../root", repo: "notes" },
      public: true,
    })).toThrow("Invalid repository owner");
    expect(() => normalizeRepoMetadataMutation({
      kind: "register",
      call: "repo.create",
      repo: { owner: "alice", repo: ".." },
    })).toThrow("Invalid repository name");

    expect(parseRepoMetadataConfigKey("repos/alice/notes/visibility")).toEqual({
      owner: "alice",
      repo: "notes",
      field: "visibility",
    });
    expect(parseRepoMetadataConfigKey("repos/alice/notes/provider_token")).toBeNull();
    expect(parseRepoMetadataConfigKey("repos/alice/notes/visibility/extra")).toBeNull();
  });

  it("writes and deletes only the four repository metadata keys", () => {
    const config = makeConfig({
      "repos/alice/notes/created_at": "10",
      "repos/alice/notes/updated_at": "20",
      "repos/alice/notes/visibility": "public",
      "repos/alice/notes/unrelated": "preserve",
    });

    expect(applyRepoMetadataMutation(config, {
      kind: "register",
      call: "repo.import",
      repo: { owner: "alice", repo: "notes" },
      description: "Imported notes",
    }, 15)).toEqual({ changed: true });
    expect(config.values.get("repos/alice/notes/created_at")).toBe("10");
    expect(config.values.get("repos/alice/notes/updated_at")).toBe("21");
    expect(config.values.get("repos/alice/notes/description")).toBe("Imported notes");

    expect(applyRepoMetadataMutation(config, {
      kind: "delete",
      call: "repo.delete",
      repo: { owner: "alice", repo: "notes" },
    })).toEqual({ changed: true });
    expect([...config.values.entries()]).toEqual([
      ["repos/alice/notes/unrelated", "preserve"],
    ]);
  });

  it("projects private metadata only to its owner while sharing complete public metadata", () => {
    const entries = [
      { key: "repos/alice/private/created_at", value: "1" },
      { key: "repos/alice/private/description", value: "private" },
      { key: "repos/bob/public/created_at", value: "2" },
      { key: "repos/bob/public/description", value: "public" },
      { key: "repos/bob/public/visibility", value: "public" },
      { key: "repos/bob/private/created_at", value: "3" },
      { key: "repos/bob/private/description", value: "hidden" },
      { key: "repos/bob/private/provider_token", value: "never-project" },
    ];

    expect(selectRepoMetadataProjection(entries, new Set(["alice"]), false)).toEqual([
      { key: "repos/alice/private/created_at", value: "1" },
      { key: "repos/alice/private/description", value: "private" },
      { key: "repos/bob/public/created_at", value: "2" },
      { key: "repos/bob/public/description", value: "public" },
      { key: "repos/bob/public/visibility", value: "public" },
    ]);
    expect(selectRepoMetadataProjection(entries, new Set(), true)).not.toContainEqual({
      key: "repos/bob/private/provider_token",
      value: "never-project",
    });
  });
});
