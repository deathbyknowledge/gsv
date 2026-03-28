import { RipgitClient } from "./ripgit/client";
import type {
  RipgitApplyOp,
  RipgitRepoRef,
  RipgitSearchMatch,
} from "./ripgit/client";
import { homeKnowledgeRepoRef } from "./ripgit/repos";
import { normalizePath } from "./utils";

export type KnowledgeStoreEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
};

export type KnowledgeStoreReadResult =
  | { kind: "missing" }
  | { kind: "file"; bytes: Uint8Array; size: number }
  | { kind: "directory"; entries: KnowledgeStoreEntry[] };

export type KnowledgeStoreSearchMatch = {
  path: string;
  line: number;
  content: string;
};

export type KnowledgeStoreWriteOptions = {
  authorName: string;
  authorEmail?: string;
  message: string;
};

export type KnowledgeStoreDeleteOptions = KnowledgeStoreWriteOptions & {
  recursive?: boolean;
};

export type KnowledgeStoreSearchOptions = {
  prefix?: string;
  include?: string;
  limit?: number;
};

export interface KnowledgeStore {
  read(path: string): Promise<KnowledgeStoreReadResult>;
  list(prefix?: string): Promise<KnowledgeStoreEntry[]>;
  write(
    path: string,
    content: string | Uint8Array,
    options: KnowledgeStoreWriteOptions,
  ): Promise<void>;
  delete(path: string, options: KnowledgeStoreDeleteOptions): Promise<void>;
  search(
    query: string,
    options?: KnowledgeStoreSearchOptions,
  ): Promise<{ matches: KnowledgeStoreSearchMatch[]; truncated?: boolean }>;
}

export function createHomeKnowledgeStore(
  env: Pick<Env, "RIPGIT" | "RIPGIT_INTERNAL_KEY">,
  ownerUid: number,
): KnowledgeStore | null {
  if (!env.RIPGIT) {
    return null;
  }

  const client = new RipgitClient(env.RIPGIT, env.RIPGIT_INTERNAL_KEY ?? null);

  return new RipgitKnowledgeStore(
    {
      readPath: (...args) => client.readPath(...args),
      apply: (...args) => client.apply(...args),
      search: (...args) => client.search(...args),
    },
    homeKnowledgeRepoRef(ownerUid),
  );
}

type RipgitKnowledgeClient = Pick<RipgitClient, "readPath" | "apply" | "search">;

export class RipgitKnowledgeStore implements KnowledgeStore {
  constructor(
    private readonly client: RipgitKnowledgeClient,
    private readonly repo: RipgitRepoRef,
  ) {}

  async read(path: string): Promise<KnowledgeStoreReadResult> {
    const repoPath = normalizeKnowledgePath(path);
    const result = await this.client.readPath(this.repo, repoPath);
    if (result.kind === "missing") {
      return { kind: "missing" };
    }
    if (result.kind === "file") {
      return result;
    }
    return {
      kind: "directory",
      entries: result.entries.map((entry) => ({
        name: entry.name,
        path: joinKnowledgePath(repoPath, entry.name),
        kind: entry.type === "tree"
          ? "directory"
          : entry.type === "blob"
            ? "file"
            : "symlink",
      })),
    };
  }

  async list(prefix = ""): Promise<KnowledgeStoreEntry[]> {
    const result = await this.read(prefix);
    return result.kind === "directory" ? result.entries : [];
  }

  async write(
    path: string,
    content: string | Uint8Array,
    options: KnowledgeStoreWriteOptions,
  ): Promise<void> {
    const repoPath = normalizeKnowledgePath(path);
    await this.apply(
      [
        {
          type: "put",
          path: repoPath,
          contentBytes: Array.from(asBytes(content)),
        },
      ],
      options,
    );
  }

  async delete(path: string, options: KnowledgeStoreDeleteOptions): Promise<void> {
    const repoPath = normalizeKnowledgePath(path);
    const ops: RipgitApplyOp[] = [
      {
        type: "delete",
        path: repoPath,
        recursive: options.recursive,
      },
    ];

    if (repoPath.length > 0) {
      ops.push({
        type: "delete",
        path: joinKnowledgePath(repoPath, ".dir"),
      });
    }

    await this.apply(ops, options);
  }

  async search(
    query: string,
    options: KnowledgeStoreSearchOptions = {},
  ): Promise<{ matches: KnowledgeStoreSearchMatch[]; truncated?: boolean }> {
    const prefix = options.prefix ? normalizeKnowledgePath(options.prefix) : undefined;
    const result = await this.client.search(this.repo, query, prefix);
    const matcher = options.include ? compileGlob(options.include) : null;
    const limit = options.limit && options.limit > 0 ? options.limit : result.matches.length;

    const matches: KnowledgeStoreSearchMatch[] = [];
    for (const match of result.matches) {
      if (matcher && !matcher.test(match.path.split("/").pop() ?? match.path)) {
        continue;
      }
      matches.push(toKnowledgeSearchMatch(match));
      if (matches.length >= limit) {
        return {
          matches,
          truncated: true,
        };
      }
    }

    return {
      matches,
      truncated: result.truncated,
    };
  }

  private async apply(
    ops: RipgitApplyOp[],
    options: KnowledgeStoreWriteOptions,
  ): Promise<void> {
    await this.client.apply(
      this.repo,
      options.authorName,
      options.authorEmail ?? `${options.authorName}@gsv.internal`,
      options.message,
      ops,
    );
  }
}

function asBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  return content;
}

function normalizeKnowledgePath(path: string): string {
  const normalized = normalizePath(path.startsWith("/") ? path : `/${path}`);
  return normalized === "/" ? "" : normalized.slice(1);
}

function joinKnowledgePath(prefix: string, name: string): string {
  return prefix ? `${prefix.replace(/\/+$/, "")}/${name}` : name;
}

function toKnowledgeSearchMatch(match: RipgitSearchMatch): KnowledgeStoreSearchMatch {
  return {
    path: match.path,
    line: match.line,
    content: match.content,
  };
}

function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}
