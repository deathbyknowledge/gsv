export type RipgitTreeEntry = {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink";
};

export type RipgitRepoRef = {
  owner: string;
  repo: string;
  branch?: string;
};

export type RipgitApplyOp =
  | {
      type: "put";
      path: string;
      contentBytes: number[];
      message?: string;
    }
  | {
      type: "symlink";
      path: string;
      target: string;
    }
  | {
      type: "delete";
      path: string;
      recursive?: boolean;
    }
  | {
      type: "move";
      from: string;
      to: string;
    };

export type RipgitPathResult =
  | { kind: "missing" }
  | { kind: "file"; bytes: Uint8Array; size: number }
  | { kind: "tree"; entries: RipgitTreeEntry[] };

export type RipgitSearchMatch = {
  path: string;
  line: number;
  content: string;
};

export type RipgitDiffLine = {
  tag: "context" | "add" | "delete" | "binary";
  content: string;
};

export type RipgitDiffHunk = {
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
  lines: RipgitDiffLine[];
};

export type RipgitDiffFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  old_hash?: string;
  new_hash?: string;
  hunks?: RipgitDiffHunk[];
};

export type RipgitCommitDiffResponse = {
  commit_hash: string;
  parent_hash?: string | null;
  files: RipgitDiffFile[];
  stats: {
    files_changed: number;
    additions: number;
    deletions: number;
  };
};

export type RipgitCompareResponse = {
  base_hash: string;
  head_hash: string;
  files: RipgitDiffFile[];
  stats: {
    files_changed: number;
    additions: number;
    deletions: number;
  };
};

export type RipgitRefsResponse = {
  heads: Record<string, string>;
  tags: Record<string, string>;
  remotes?: Record<string, string>;
};

export type RipgitLogEntry = {
  hash: string;
  tree_hash: string;
  author: string;
  author_email: string;
  author_time: number;
  committer: string;
  committer_email: string;
  commit_time: number;
  message: string;
  parents: string[];
};

type RipgitApplyResponse = {
  ok: boolean;
  head?: string | null;
  conflict?: boolean;
  error?: string;
};

export type RipgitApplyResult = {
  head?: string | null;
  conflict?: boolean;
};

type RipgitImportResponse = {
  ok: boolean;
  head?: string | null;
  changed?: boolean;
  remote_url?: string;
  remote_ref?: string;
  tracking_ref?: string;
  upstream_head?: string;
  upstream_changed?: boolean;
  local_changed?: boolean;
  diverged?: boolean;
};
type RipgitApplyBody = {
  defaultBranch: string;
  author: string;
  email: string;
  message: string;
  ops: RipgitApplyOp[];
  baseRef?: string;
  expectedHead?: string;
  allowEmpty?: true;
};
type RipgitImportBody = {
  defaultBranch: string;
  author: string;
  email: string;
  message: string;
  remoteUrl?: string;
  remoteRef?: string;
};

export type RipgitImportResult = {
  head?: string | null;
  changed: boolean;
  remoteUrl: string;
  remoteRef: string;
  trackingRef?: string;
  upstreamHead?: string;
  upstreamChanged?: boolean;
  localChanged?: boolean;
  diverged?: boolean;
};

type RipgitSearchResponse = {
  ok: boolean;
  matches?: RipgitSearchMatch[];
  truncated?: boolean;
  error?: string;
};

const DEFAULT_BRANCH = "main";

export class RipgitClient {
  constructor(private readonly binding: Fetcher) {}

  async readPath(repo: RipgitRepoRef, path: string): Promise<RipgitPathResult> {
    const response = await this.binding.fetch(this.makeReadUrl(repo, path), {
      headers: this.makeInternalHeaders(),
    });
    if (response.status === 404) {
      return { kind: "missing" };
    }
    if (!response.ok) {
      throw new Error(await this.readError(response, `read '${repo.owner}/${repo.repo}:${path}'`));
    }

    if (this.isTreeResponse(response)) {
      const entries = await response.json<RipgitTreeEntry[]>();
      return { kind: "tree", entries };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const sizeHeader = response.headers.get("X-Blob-Size");
    const size = sizeHeader ? parseInt(sizeHeader, 10) : bytes.length;
    return {
      kind: "file",
      bytes,
      size: Number.isFinite(size) ? size : bytes.length,
    };
  }

  async apply(
    repo: RipgitRepoRef,
    author: string,
    email: string,
    message: string,
    ops: RipgitApplyOp[],
    options?: {
      baseRef?: string;
      expectedHead?: string;
      allowEmpty?: boolean;
    },
  ): Promise<RipgitApplyResult> {
    const applyBody: RipgitApplyBody = {
      defaultBranch: repo.branch ?? DEFAULT_BRANCH,
      author,
      email,
      message,
      ops,
    };
    if (options?.baseRef) applyBody.baseRef = options.baseRef;
    if (options?.expectedHead) applyBody.expectedHead = options.expectedHead;
    if (options?.allowEmpty) applyBody.allowEmpty = true;
    const response = await this.binding.fetch(this.makeApplyUrl(repo), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.makeInternalHeaders(),
      },
      body: JSON.stringify(applyBody),
    });

    if (!response.ok) {
      throw new Error(await this.readError(response, `apply '${repo.owner}/${repo.repo}'`));
    }

    const payload = await response.json<RipgitApplyResponse>();
    if (!payload.ok) {
      throw new Error(payload.error ?? `Failed to apply changes for ${repo.owner}/${repo.repo}`);
    }
    return {
      head: payload.head ?? null,
      conflict: payload.conflict,
    };
  }

  async importFromUpstream(
    repo: RipgitRepoRef,
    author: string,
    email: string,
    message: string,
    remoteUrl?: string,
    remoteRef?: string,
  ): Promise<RipgitImportResult> {
    const importBody: RipgitImportBody = {
      defaultBranch: repo.branch ?? DEFAULT_BRANCH,
      author,
      email,
      message,
    };
    if (remoteUrl) importBody.remoteUrl = remoteUrl;
    if (remoteRef) importBody.remoteRef = remoteRef;
    const response = await this.binding.fetch(this.makeImportUrl(repo), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.makeInternalHeaders(),
      },
      body: JSON.stringify(importBody),
    });

    if (!response.ok) {
      throw new Error(await this.readError(response, `import '${repo.owner}/${repo.repo}'`));
    }

    const payload = await response.json<RipgitImportResponse>();
    if (!payload.ok || !payload.remote_url || !payload.remote_ref) {
      throw new Error(`Failed to import upstream for ${repo.owner}/${repo.repo}`);
    }

    return {
      head: payload.head ?? null,
      changed: payload.changed === true,
      remoteUrl: payload.remote_url,
      remoteRef: payload.remote_ref,
      trackingRef: payload.tracking_ref,
      upstreamHead: payload.upstream_head,
      upstreamChanged: payload.upstream_changed,
      localChanged: payload.local_changed,
      diverged: payload.diverged,
    };
  }

  async deleteRepository(repo: RipgitRepoRef, actor: string): Promise<boolean> {
    const response = await this.binding.fetch(this.makeRepositoryUrl(repo), {
      method: "DELETE",
      headers: {
        ...this.makeInternalHeaders(),
        "X-Ripgit-Actor-Name": actor,
      },
    });
    if (!response.ok) {
      throw new Error(await this.readError(response, `delete '${repo.owner}/${repo.repo}'`));
    }
    return true;
  }

  async search(
    repo: RipgitRepoRef,
    query: string,
    prefix?: string,
    signal?: AbortSignal,
  ): Promise<{ matches: RipgitSearchMatch[]; truncated?: boolean }> {
    const response = await this.binding.fetch(this.makeSearchUrl(repo, query, prefix), {
      headers: this.makeInternalHeaders(),
      signal,
    });
    if (!response.ok) {
      throw new Error(await this.readError(response, `search '${repo.owner}/${repo.repo}'`));
    }

    const payload = await response.json<RipgitSearchResponse>();
    if (!payload.ok) {
      throw new Error(payload.error ?? `Failed to search ${repo.owner}/${repo.repo}`);
    }

    return {
      matches: Array.isArray(payload.matches) ? payload.matches : [],
      truncated: payload.truncated,
    };
  }

  async refs(repo: RipgitRepoRef): Promise<RipgitRefsResponse> {
    const response = await this.binding.fetch(this.makeRefsUrl(repo), {
      headers: this.makeInternalHeaders(),
    });
    if (!response.ok) {
      throw new Error(await this.readError(response, `refs '${repo.owner}/${repo.repo}'`));
    }
    return response.json<RipgitRefsResponse>();
  }

  async log(
    repo: RipgitRepoRef,
    options?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<RipgitLogEntry[]> {
    const response = await this.binding.fetch(
      this.makeLogUrl(repo, options?.limit, options?.offset),
      {
        headers: this.makeInternalHeaders(),
      },
    );
    if (!response.ok) {
      throw new Error(await this.readError(response, `log '${repo.owner}/${repo.repo}'`));
    }
    return response.json<RipgitLogEntry[]>();
  }

  async diffCommit(
    repo: RipgitRepoRef,
    commit: string,
    options?: {
      context?: number;
    },
  ): Promise<RipgitCommitDiffResponse> {
    const response = await this.binding.fetch(
      this.makeDiffUrl(repo, commit, options?.context),
      {
        headers: this.makeInternalHeaders(),
      },
    );
    if (!response.ok) {
      throw new Error(await this.readError(response, `diff '${repo.owner}/${repo.repo}:${commit}'`));
    }
    return response.json<RipgitCommitDiffResponse>();
  }

  async compare(
    repo: RipgitRepoRef,
    base: string,
    head: string,
    options?: {
      context?: number;
      stat?: boolean;
    },
  ): Promise<RipgitCompareResponse> {
    const response = await this.binding.fetch(
      this.makeCompareUrl(repo, base, head, options?.context, options?.stat),
      {
        headers: this.makeInternalHeaders(),
      },
    );
    if (!response.ok) {
      throw new Error(await this.readError(response, `compare '${repo.owner}/${repo.repo}:${base}...${head}'`));
    }
    return response.json<RipgitCompareResponse>();
  }

  private makeReadUrl(repo: RipgitRepoRef, path: string): URL {
    return this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/read?ref=${encodeURIComponent(repo.branch ?? DEFAULT_BRANCH)}&path=${encodeURIComponent(path)}`,
    );
  }

  private makeRepositoryUrl(repo: RipgitRepoRef): URL {
    return this.makeUrl(
      `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
    );
  }

  private makeApplyUrl(repo: RipgitRepoRef): URL {
    return this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/apply`,
    );
  }

  private makeImportUrl(repo: RipgitRepoRef): URL {
    return this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/import`,
    );
  }

  private makeSearchUrl(repo: RipgitRepoRef, query: string, prefix?: string): URL {
    const url = this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/search?query=${encodeURIComponent(query)}`,
    );
    if (prefix && prefix.length > 0) {
      url.searchParams.set("prefix", prefix);
    }
    url.searchParams.set("limit", "500");
    return url;
  }

  private makeRefsUrl(repo: RipgitRepoRef): URL {
    return this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/refs`,
    );
  }

  private makeLogUrl(repo: RipgitRepoRef, limit?: number, offset?: number): URL {
    const url = this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/log?ref=${encodeURIComponent(repo.branch ?? DEFAULT_BRANCH)}`,
    );
    if (limit !== undefined && Number.isFinite(limit)) {
      url.searchParams.set("limit", String(limit));
    }
    if (offset !== undefined && Number.isFinite(offset)) {
      url.searchParams.set("offset", String(offset));
    }
    return url;
  }

  private makeDiffUrl(repo: RipgitRepoRef, commit: string, context?: number): URL {
    const url = this.makeUrl(
      `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/diff/${encodeURIComponent(commit)}`,
    );
    if (context !== undefined && Number.isFinite(context)) {
      url.searchParams.set("context", String(context));
    }
    return url;
  }

  private makeCompareUrl(
    repo: RipgitRepoRef,
    base: string,
    head: string,
    context?: number,
    stat?: boolean,
  ): URL {
    const url = this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
    );
    if (context !== undefined && Number.isFinite(context)) {
      url.searchParams.set("context", String(context));
    }
    if (stat) {
      url.searchParams.set("stat", "1");
    }
    return url;
  }

  private makeUrl(suffix: string): URL {
    return new URL(`https://ripgit${suffix}`);
  }

  private makeInternalHeaders(): Record<string, string> {
    return {};
  }

  private isTreeResponse(response: Response): boolean {
    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    return contentType.startsWith("application/json");
  }

  private async readError(response: Response, context: string): Promise<string> {
    const text = await response.text().catch(() => "");
    if (text) {
      return text;
    }
    return `ripgit ${context} failed with ${response.status}`;
  }
}
