export type KnowledgeSourceRef = {
  target: string;
  path: string;
  title?: string;
};

export type KnowledgeDbListArgs = {
  limit?: number;
};

export type KnowledgeDbListResult = {
  dbs: Array<{
    id: string;
    title?: string;
  }>;
};

export type KnowledgeDbInitArgs = {
  id: string;
  title?: string;
  description?: string;
};

export type KnowledgeDbInitResult =
  | {
      ok: true;
      id: string;
      created: boolean;
    }
  | { ok: false; error: string };

export type KnowledgeListArgs = {
  prefix?: string;
  recursive?: boolean;
  limit?: number;
};

export type KnowledgeListResult = {
  entries: Array<{
    path: string;
    kind: "file" | "dir";
    title?: string;
    updatedAt?: string;
  }>;
};

export type KnowledgeReadArgs = {
  path: string;
};

export type KnowledgeReadResult = {
  path: string;
  exists: boolean;
  title?: string;
  frontmatter?: Record<string, unknown>;
  markdown?: string;
  sources?: KnowledgeSourceRef[];
};

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

export type KnowledgeWriteResult =
  | {
      ok: true;
      path: string;
      created: boolean;
      updated: boolean;
    }
  | { ok: false; error: string };

export type KnowledgeSearchArgs = {
  query: string;
  prefix?: string;
  limit?: number;
};

export type KnowledgeSearchResult = {
  matches: Array<{
    path: string;
    title?: string;
    snippet: string;
    score?: number;
  }>;
};

export type KnowledgeMergeArgs = {
  sourcePath: string;
  targetPath: string;
  mode?: "prefer-target" | "prefer-source" | "union";
  keepSource?: boolean;
};

export type KnowledgeMergeResult =
  | {
      ok: true;
      targetPath: string;
      sourcePath: string;
      removedSource: boolean;
    }
  | { ok: false; error: string };

export type KnowledgePromoteArgs = {
  source:
    | { kind: "text"; text: string }
    | { kind: "candidate"; path: string }
    | { kind: "process"; pid: string; runId?: string; messageIds?: number[] };
  targetPath?: string;
  mode?: "inbox" | "direct";
};

export type KnowledgePromoteResult =
  | {
      ok: true;
      path: string;
      created: boolean;
      requiresReview: boolean;
    }
  | { ok: false; error: string };

export type KnowledgeQueryArgs = {
  query: string;
  prefixes?: string[];
  limit?: number;
  maxBytes?: number;
};

export type KnowledgeQueryResult = {
  brief: string;
  refs: Array<{
    path: string;
    title?: string;
  }>;
};

export type KnowledgeIngestArgs = {
  db: string;
  sources: KnowledgeSourceRef[];
  title?: string;
  summary?: string;
  path?: string;
  mode?: "inbox" | "page";
};

export type KnowledgeIngestResult =
  | {
      ok: true;
      db: string;
      path: string;
      created: boolean;
      requiresReview: boolean;
    }
  | { ok: false; error: string };

export type KnowledgeCompileArgs = {
  db: string;
  sourcePath: string;
  targetPath?: string;
  title?: string;
  keepSource?: boolean;
};

export type KnowledgeCompileResult =
  | {
      ok: true;
      db: string;
      path: string;
      sourcePath: string;
      removedSource: boolean;
    }
  | { ok: false; error: string };
