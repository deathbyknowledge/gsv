import { describe, expect, it, vi } from "vitest";
import type { AuthStore } from "./auth-store";
import type { ConfigStore } from "./config";
import {
  listInstallationRepos,
  listRegisteredRepos,
  registerRepo,
  unregisterRepo,
} from "./repo-registry";

describe("repository registry", () => {
  it("lists registered repositories and every account home exactly once", () => {
    const config = makeConfig({
      "repos/alice/home/created_at": "1",
      "repos/alice/project/created_at": "2",
      "repos/alice/project/updated_at": "3",
      "repos/not/a/repo/key": "ignored",
    });
    const auth = {
      getPasswdEntries: () => [
        { username: "root" },
        { username: "alice" },
        { username: "alice-agent" },
      ],
    } as unknown as AuthStore;

    expect(listInstallationRepos(config, auth)).toEqual([
      { owner: "alice", repo: "home" },
      { owner: "alice", repo: "project" },
      { owner: "alice-agent", repo: "home" },
      { owner: "root", repo: "home" },
    ]);
    expect(listRegisteredRepos(config)).toEqual([
      { owner: "alice", repo: "home" },
      { owner: "alice", repo: "project" },
    ]);
  });

  it("registers idempotently and removes every registry field", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const config = makeConfig({});

    registerRepo(config, { owner: "alice", repo: "notes" }, " Notes ");
    registerRepo(config, { owner: "alice", repo: "notes" });

    expect(config.get("repos/alice/notes/created_at")).toBe("1234");
    expect(config.get("repos/alice/notes/updated_at")).toBe("1234");
    expect(config.get("repos/alice/notes/description")).toBe("Notes");

    unregisterRepo(config, { owner: "alice", repo: "notes" });
    expect(config.listExplicit("repos")).toEqual([]);
  });
});

function makeConfig(seed: Record<string, string>): ConfigStore {
  const values = new Map(Object.entries(seed));
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => values.set(key, value),
    delete: (key: string) => values.delete(key),
    listExplicit: (prefix: string) => [...values.entries()]
      .filter(([key]) => key.startsWith(`${prefix}/`))
      .map(([key, value]) => ({ key, value }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  } as unknown as ConfigStore;
}
