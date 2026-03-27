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

type RipgitApplyResponse = {
  ok: boolean;
  head?: string | null;
  conflict?: boolean;
  error?: string;
};

const DEFAULT_BRANCH = "main";

export class RipgitClient {
  constructor(
    private readonly binding: Fetcher,
    private readonly internalKey: string | null,
  ) {}

  async readPath(repo: RipgitRepoRef, path: string): Promise<RipgitPathResult> {
    const response = await this.binding.fetch(this.makeFileUrl(repo, path));
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
    if (!this.internalKey) {
      throw new Error("RIPGIT_INTERNAL_KEY is not configured");
    }

    const response = await this.binding.fetch(this.makeApplyUrl(repo), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ripgit-Internal-Key": this.internalKey,
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

  private makeFileUrl(repo: RipgitRepoRef, path: string): URL {
    return this.makeUrl(
      repo.owner,
      repo.repo,
      `/file?ref=${encodeURIComponent(repo.branch ?? DEFAULT_BRANCH)}&path=${encodeURIComponent(path)}`,
    );
  }

  private makeApplyUrl(repo: RipgitRepoRef): URL {
    return this.makeUrl(repo.owner, repo.repo, "/_gsv/apply");
  }

  private makeUrl(owner: string, repo: string, suffix: string): URL {
    return new URL(`https://ripgit/${owner}/${repo}${suffix}`);
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
