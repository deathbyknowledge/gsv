import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type {
  RipgitApplyOp,
  RipgitClient,
  RipgitPathResult,
  RipgitRepoRef,
} from "../../fs";
import { seedRepoKnowledgeToHome } from "./knowledge-seed";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const SOURCE_REPO: RipgitRepoRef = {
  owner: "root",
  repo: "gsv",
  branch: "abc123",
};

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
};

type ApplyCall = {
  repo: RipgitRepoRef;
  author: string;
  email: string;
  message: string;
  ops: RipgitApplyOp[];
};

function makeRipgit(sourceFiles: Record<string, string>, homeFiles: Record<string, string> = {}) {
  const source = makeFileMap(sourceFiles);
  const home = makeFileMap(homeFiles);
  const applyCalls: ApplyCall[] = [];

  function mapFor(repo: RipgitRepoRef): Map<string, Uint8Array> {
    if (repo.owner === "root" && repo.repo === "gsv") {
      return source;
    }
    if (repo.owner === "alice" && repo.repo === "home") {
      return home;
    }
    return new Map();
  }

  const readPath = vi.fn(async (repo: RipgitRepoRef, path: string): Promise<RipgitPathResult> => {
    return readMapPath(mapFor(repo), path);
  });
  const apply = vi.fn(async (
    repo: RipgitRepoRef,
    author: string,
    email: string,
    message: string,
    ops: RipgitApplyOp[],
  ) => {
    applyCalls.push({ repo, author, email, message, ops });
    const target = mapFor(repo);
    for (const op of ops) {
      if (op.type === "put") {
        target.set(op.path, new Uint8Array(op.contentBytes));
      } else if (op.type === "delete") {
        target.delete(op.path);
      }
    }
    return { head: "home123" };
  });

  return {
    ripgit: { readPath, apply } as unknown as RipgitClient,
    readPath,
    apply,
    applyCalls,
    home,
  };
}

function makeFileMap(files: Record<string, string>): Map<string, Uint8Array> {
  return new Map(
    Object.entries(files).map(([path, text]) => [path, TEXT_ENCODER.encode(text)]),
  );
}

function readMapPath(files: Map<string, Uint8Array>, path: string): RipgitPathResult {
  const file = files.get(path);
  if (file) {
    return {
      kind: "file",
      bytes: file,
      size: file.length,
    };
  }

  const prefix = `${path.replace(/\/+$/, "")}/`;
  const children = new Map<string, "tree" | "blob">();
  for (const key of files.keys()) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const rest = key.slice(prefix.length);
    if (!rest) {
      continue;
    }
    const slashIndex = rest.indexOf("/");
    if (slashIndex === -1) {
      children.set(rest, "blob");
    } else {
      children.set(rest.slice(0, slashIndex), "tree");
    }
  }

  if (children.size === 0) {
    return { kind: "missing" };
  }

  return {
    kind: "tree",
    entries: [...children.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, type]) => ({
        name,
        type,
        mode: type === "tree" ? "040000" : "100644",
        hash: `hash:${name}`,
      })),
  };
}

function textFor(home: Map<string, Uint8Array>, path: string): string | undefined {
  const bytes = home.get(path);
  return bytes ? TEXT_DECODER.decode(bytes) : undefined;
}

describe("seedRepoKnowledgeToHome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies missing shipped manual files into home knowledge", async () => {
    const { ripgit, apply, applyCalls, home } = makeRipgit({
      "knowledge/gsv/README.md": "# GSV Manual\n",
      "knowledge/gsv/setup/onboarding.md": "# Onboarding\n",
    });

    const result = await seedRepoKnowledgeToHome(ripgit, SOURCE_REPO, IDENTITY);

    expect(result).toEqual({ username: "alice", copied: 2, skipped: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(applyCalls[0]).toMatchObject({
      repo: { owner: "alice", repo: "home" },
      author: "alice",
      email: "alice@gsv.local",
      message: "gsv: seed bootstrap knowledge",
    });
    expect(applyCalls[0].ops).toEqual([
      { type: "put", path: "knowledge/.dir", contentBytes: [] },
      { type: "put", path: "knowledge/gsv/.dir", contentBytes: [] },
      {
        type: "put",
        path: "knowledge/gsv/README.md",
        contentBytes: Array.from(TEXT_ENCODER.encode("# GSV Manual\n")),
      },
      {
        type: "put",
        path: "knowledge/gsv/setup/onboarding.md",
        contentBytes: Array.from(TEXT_ENCODER.encode("# Onboarding\n")),
      },
    ]);
    expect(textFor(home, "knowledge/gsv/README.md")).toBe("# GSV Manual\n");
    expect(textFor(home, "knowledge/gsv/setup/onboarding.md")).toBe("# Onboarding\n");
  });

  it("preserves existing home knowledge files and seeds only missing files", async () => {
    const { ripgit, applyCalls, home } = makeRipgit(
      {
        "knowledge/gsv/README.md": "# Shipped Manual\n",
        "knowledge/gsv/reference.md": "# Reference\n",
      },
      {
        "knowledge/gsv/README.md": "# User Notes\n",
      },
    );

    const result = await seedRepoKnowledgeToHome(ripgit, SOURCE_REPO, IDENTITY);

    expect(result).toEqual({ username: "alice", copied: 1, skipped: 1 });
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].ops).toEqual([
      {
        type: "put",
        path: "knowledge/gsv/reference.md",
        contentBytes: Array.from(TEXT_ENCODER.encode("# Reference\n")),
      },
    ]);
    expect(textFor(home, "knowledge/gsv/README.md")).toBe("# User Notes\n");
    expect(textFor(home, "knowledge/gsv/reference.md")).toBe("# Reference\n");
  });

  it("does nothing when the shipped manual is missing", async () => {
    const { ripgit, apply, readPath } = makeRipgit({});

    const result = await seedRepoKnowledgeToHome(ripgit, SOURCE_REPO, IDENTITY);

    expect(result).toEqual({ username: "alice", copied: 0, skipped: 0 });
    expect(apply).not.toHaveBeenCalled();
    expect(readPath).toHaveBeenCalledTimes(1);
    expect(readPath).toHaveBeenCalledWith(SOURCE_REPO, "knowledge/gsv");
  });
});
