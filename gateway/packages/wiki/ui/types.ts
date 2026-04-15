export type WikiDb = {
  id: string;
  title?: string;
};

export type WikiEntry = {
  kind?: string;
  path: string;
  title?: string;
  snippet?: string;
};

export type WikiNote = {
  path: string;
  title?: string;
  markdown: string;
};

export type WikiQueryRef = {
  path: string;
  title?: string;
};

export type WikiQueryResult = {
  brief?: string;
  refs: WikiQueryRef[];
};

export type WikiState = {
  selectedDb: string;
  selectedPath: string;
  dbs: WikiDb[];
  pages: WikiEntry[];
  inbox: WikiEntry[];
  selectedNote: WikiNote | null;
  searchQuery: string;
  searchMatches: WikiEntry[] | null;
  queryText: string;
  queryResult: WikiQueryResult | null;
  errorText: string;
};

export type WikiMutationResult = {
  db: string;
  openPath: string;
  statusText: string;
};

export type WikiLoadArgs = {
  db?: string;
  path?: string;
  q?: string;
  ask?: string;
};

export type WikiPreviewRequest =
  | {
      kind: "page";
      db?: string;
      path: string;
    }
  | {
      kind: "source";
      target: string;
      path: string;
      title?: string;
    };

export type WikiPreviewPayload =
  | {
      ok: false;
      error: string;
    }
  | {
      ok: true;
      kind: "page";
      title: string;
      path: string;
      markdown: string;
    }
  | {
      ok: true;
      kind: "source";
      target: string;
      path: string;
      title: string;
      mode: "unavailable" | "directory" | "image" | "markdown" | "text";
      text?: string;
      directories?: string[];
      files?: string[];
      image?: {
        data: string;
        mimeType: string;
      } | null;
    };

export interface WikiBackend {
  loadState(args: WikiLoadArgs): Promise<WikiState>;
  preview(args: WikiPreviewRequest): Promise<WikiPreviewPayload>;
  createDatabase(args: { dbId: string; dbTitle?: string }): Promise<WikiMutationResult>;
  writePage(args: { db: string; path: string; markdown: string }): Promise<WikiMutationResult>;
  ingestSourcesToInbox(args: { db: string; title?: string; summary?: string; sources: string }): Promise<WikiMutationResult>;
  compileInboxNote(args: { db: string; sourcePath: string; targetPath?: string }): Promise<WikiMutationResult>;
  startBuildFromDirectory(args: { buildTarget: string; buildSourcePath: string; buildDbId: string; buildDbTitle?: string }): Promise<WikiMutationResult>;
}
