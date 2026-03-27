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

type RipgitApplyResponse = {
  ok: boolean;
  head?: string | null;
  conflict?: boolean;
  error?: string;
};

type RipgitSearchResponse = {
  ok: boolean;
  matches?: RipgitSearchMatch[];
  truncated?: boolean;
  error?: string;
};

const DEFAULT_BRANCH = "main";

export class RipgitClient {
  constructor(
    private readonly binding: Fetcher,
    private readonly internalKey: string | null,
  ) {}

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
  ): Promise<void> {
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

  private makeUrl(suffix: string): URL {
    return new URL(`https://ripgit${suffix}`);
  }

  private makeInternalHeaders(): Record<string, string> {
    if (!this.internalKey) {
      throw new Error("RIPGIT_INTERNAL_KEY is not configured");
    }
    return {
      "X-Ripgit-Internal-Key": this.internalKey,
    };
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
