import type { RepoReadResult } from "@gsv/protocol/syscalls/repositories";

export type WikiKernelClient = {
  request<T = unknown>(name: string, args: unknown): Promise<T>;
};

export type WikiCollection = {
  id: string;
  title?: string;
  repo: string;
  prefix: string;
  writable: boolean;
};

export type KnowledgeSourceRef = { target: string; path: string; title?: string };

export type KnowledgeWriteArgs = {
  path: string;
  mode?: "replace" | "merge" | "append";
  markdown?: string;
  patch?: {
    title?: string;
    summary?: string;
    addFacts?: string[];
    addPreferences?: string[];
    addEvidence?: string[];
    addAliases?: string[];
    addTags?: string[];
    addLinks?: string[];
    addSources?: KnowledgeSourceRef[];
    sections?: Array<{
      heading: string;
      mode?: "replace" | "append" | "delete";
      content?: string | string[];
    }>;
  };
  create?: boolean;
};

export type KnowledgePromoteArgs = {
  source:
    | { kind: "text"; text: string }
    | { kind: "candidate"; path: string }
    | { kind: "process"; pid: string; runId?: string; messageIds?: number[] };
  targetPath?: string;
  mode?: "inbox" | "direct";
};

export type KnowledgeCompileArgs = { db: string; sourcePath: string; targetPath?: string; title?: string; keepSource?: boolean };
export type KnowledgeDbDeleteArgs = { id: string };
export type KnowledgeDbInitArgs = { id: string; title?: string; description?: string };
export type KnowledgeIngestArgs = {
  db: string;
  sources: KnowledgeSourceRef[];
  title?: string;
  summary?: string;
  path?: string;
  mode?: "inbox" | "page";
};
export type KnowledgeListArgs = { prefix?: string; recursive?: boolean; limit?: number };
export type KnowledgeMergeArgs = { sourcePath: string; targetPath: string; mode?: "prefer-target" | "prefer-source" | "union"; keepSource?: boolean };
export type KnowledgeReadArgs = { path: string };
export type KnowledgeSearchArgs = { query: string; prefix?: string; limit?: number };
export type WikiInfoArgs = { id: string };

export type WikiInfoTreeEntry = {
  path: string;
  kind: "file" | "dir";
  title?: string;
};

export type WikiInfoResult = {
  id: string;
  title?: string;
  repo: string;
  writable: boolean;
  tree: WikiInfoTreeEntry[];
};

export type KnowledgeDoc = {
  frontmatter: Record<string, unknown>;
  title: string;
  summary: string[];
  facts: string[];
  preferences: string[];
  evidence: string[];
  aliases: string[];
  tags: string[];
  links: string[];
  sources: KnowledgeSourceRef[];
  otherSections: Array<{ heading: string; lines: string[] }>;
};

export type SearchMatch = {
  path: string;
  title?: string;
  snippet: string;
  score: number;
};

export type RepoNode =
  | { kind: "missing" }
  | { kind: "tree"; entries: Extract<RepoReadResult, { kind: "tree" }>["entries"] }
  | { kind: "file"; content: string | null; isBinary: boolean; size: number };
