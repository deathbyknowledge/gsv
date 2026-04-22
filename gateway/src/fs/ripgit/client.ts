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

export type RipgitRefsResponse = {
  heads: Record<string, string>;
  tags: Record<string, string>;
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

export type RipgitPackageDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
  line: number;
  column: number;
};

export type RipgitPackageAnalyzeResponse = {
  source: {
    repo: string;
    ref: string;
    resolved_commit: string;
    subdir: string;
  };
  package_root: string;
  identity: {
    package_json_name: string;
    version?: string | null;
    display_name: string;
  };
  package_json: {
    name: string;
    version?: string | null;
    type?: string | null;
    dependencies: Record<string, string>;
    dev_dependencies: Record<string, string>;
  };
  definition?: {
    meta: {
      display_name: string;
      description?: string | null;
      icon?: string | null;
      window?: {
        width?: number | null;
        height?: number | null;
        min_width?: number | null;
        min_height?: number | null;
      } | null;
      capabilities: {
        kernel: string[];
        outbound: string[];
      };
    };
    commands: Array<{
      name: string;
    }>;
    app?: {
      handler: {
        export_name: string;
      };
      has_rpc: boolean;
      rpc_methods: string[];
      browser_entry?: string | null;
      assets: string[];
    } | null;
  } | null;
  diagnostics: RipgitPackageDiagnostic[];
  ok: boolean;
  analysis_hash: string;
};

export type RipgitPackageSnapshotResponse = {
  source: {
    repo: string;
    ref: string;
    resolved_commit: string;
    subdir: string;
  };
  package_root: string;
  files: Record<string, string>;
};

type RipgitApplyResponse = {
  ok: boolean;
  head?: string | null;
  conflict?: boolean;
  error?: string;
};

export type RipgitApplyResult = {
  head?: string | null;
};

type RipgitImportResponse = {
  ok: boolean;
  head?: string | null;
  changed?: boolean;
  remote_url?: string;
  remote_ref?: string;
};

export type RipgitImportResult = {
  head?: string | null;
  changed: boolean;
  remoteUrl: string;
  remoteRef: string;
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
  ): Promise<RipgitApplyResult> {
    const response = await this.binding.fetch(this.makeApplyUrl(repo), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.makeInternalHeaders(),
      },
      body: JSON.stringify({
        defaultBranch: repo.branch ?? DEFAULT_BRANCH,
        author,
        email,
        message,
        ops,
      }),
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
    const response = await this.binding.fetch(this.makeImportUrl(repo), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.makeInternalHeaders(),
      },
      body: JSON.stringify({
        defaultBranch: repo.branch ?? DEFAULT_BRANCH,
        author,
        email,
        message,
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(remoteRef ? { remoteRef } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(await this.readError(response, `import '${repo.owner}/${repo.repo}'`));
    }

    const payload = await response.json<RipgitImportResponse>();
    if (!payload.ok || typeof payload.remote_url !== "string" || typeof payload.remote_ref !== "string") {
      throw new Error(`Failed to import upstream for ${repo.owner}/${repo.repo}`);
    }

    return {
      head: payload.head ?? null,
      changed: payload.changed === true,
      remoteUrl: payload.remote_url,
      remoteRef: payload.remote_ref,
    };
  }

  async search(
    repo: RipgitRepoRef,
    query: string,
    prefix?: string,
  ): Promise<{ matches: RipgitSearchMatch[]; truncated?: boolean }> {
    const response = await this.binding.fetch(this.makeSearchUrl(repo, query, prefix), {
      headers: this.makeInternalHeaders(),
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

  async analyzePackage(
    repo: RipgitRepoRef,
    subdir: string,
  ): Promise<RipgitPackageAnalyzeResponse> {
    const response = await this.binding.fetch(this.makePackagesAnalyzeUrl(repo, subdir), {
      headers: this.makeInternalHeaders(),
    });
    if (!response.ok) {
      throw new Error(await this.readError(response, `analyze package '${repo.owner}/${repo.repo}:${subdir}'`));
    }
    return response.json<RipgitPackageAnalyzeResponse>();
  }

  async snapshotPackage(
    repo: RipgitRepoRef,
    subdir: string,
  ): Promise<RipgitPackageSnapshotResponse> {
    const response = await this.binding.fetch(this.makePackagesSnapshotUrl(repo, subdir), {
      headers: this.makeInternalHeaders(),
    });
    if (!response.ok) {
      throw new Error(await this.readError(response, `snapshot package '${repo.owner}/${repo.repo}:${subdir}'`));
    }
    return response.json<RipgitPackageSnapshotResponse>();
  }

  private makeReadUrl(repo: RipgitRepoRef, path: string): URL {
    return this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/read?ref=${encodeURIComponent(repo.branch ?? DEFAULT_BRANCH)}&path=${encodeURIComponent(path)}`,
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
    if (typeof limit === "number" && Number.isFinite(limit)) {
      url.searchParams.set("limit", String(limit));
    }
    if (typeof offset === "number" && Number.isFinite(offset)) {
      url.searchParams.set("offset", String(offset));
    }
    return url;
  }

  private makeDiffUrl(repo: RipgitRepoRef, commit: string, context?: number): URL {
    const url = this.makeUrl(
      `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/diff/${encodeURIComponent(commit)}`,
    );
    if (typeof context === "number" && Number.isFinite(context)) {
      url.searchParams.set("context", String(context));
    }
    return url;
  }

  private makePackagesAnalyzeUrl(repo: RipgitRepoRef, subdir: string): URL {
    return this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/packages/analyze?ref=${encodeURIComponent(repo.branch ?? DEFAULT_BRANCH)}&subdir=${encodeURIComponent(subdir)}`,
    );
  }

  private makePackagesSnapshotUrl(repo: RipgitRepoRef, subdir: string): URL {
    return this.makeUrl(
      `/hyperspace/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/packages/snapshot?ref=${encodeURIComponent(repo.branch ?? DEFAULT_BRANCH)}&subdir=${encodeURIComponent(subdir)}`,
    );
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
