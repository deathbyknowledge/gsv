import { describe, expect, it } from "vitest";
import type { RepositoryRefs } from "./models";
import { isLocalBranchRef } from "./presentation";

describe("repository presentation", () => {
  it("only treats refs.heads entries as local branch refs", () => {
    const refs: RepositoryRefs = {
      repo: "root/gsv",
      heads: {
        main: "main123",
        "feature/repos": "feature123",
      },
      tags: {
        v1: "tag123",
      },
      remotes: {
        "origin/main": "remote123",
      },
    };

    expect(isLocalBranchRef(refs, "main")).toBe(true);
    expect(isLocalBranchRef(refs, "feature/repos")).toBe(true);
    expect(isLocalBranchRef(refs, "main123")).toBe(false);
    expect(isLocalBranchRef(refs, "v1")).toBe(false);
    expect(isLocalBranchRef(refs, "refs/remotes/origin/main")).toBe(false);
    expect(isLocalBranchRef(refs, "refs/heads/main")).toBe(false);
    expect(isLocalBranchRef(null, "main")).toBe(false);
  });
});
