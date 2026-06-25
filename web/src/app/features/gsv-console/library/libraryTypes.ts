export type LibraryCollection = {
  id: string;
  title: string;
  repo: string;
  writable: boolean;
  updatedAt: number | null;
};

export type LibraryEntry = {
  kind: "file" | "dir";
  path: string;
  title: string;
  snippet?: string;
};

export type LibraryNote = {
  path: string;
  title: string;
  markdown: string;
};

export type LibraryWorkspaceState = {
  selectedDb: string;
  selectedPath: string;
  dbs: LibraryCollection[];
  pages: LibraryEntry[];
  selectedNote: LibraryNote | null;
  searchQuery: string;
  searchMatches: LibraryEntry[] | null;
  errorText: string;
};

export type LibraryLoadArgs = {
  db?: string;
  path?: string;
  q?: string;
};

export type LibraryMutationResult = {
  db: string;
  openPath: string;
  statusText: string;
};

export type LibraryMode = "read" | "edit" | "ingest" | "build";

export type LibraryTreeNode = {
  id: string;
  name: string;
  path: string;
  title: string;
  kind: "root" | "folder" | "file";
  children: LibraryTreeNode[];
  entry?: LibraryEntry;
  count: number;
};

export type LibraryCreateCollectionInput = {
  dbId: string;
  dbTitle?: string;
};

export type LibrarySavePageInput = {
  db: string;
  path: string;
  markdown: string;
};

export type LibraryIngestSourceInput = {
  db: string;
  sourceTarget: string;
  sourcePath: string;
  sourceTitle?: string;
  summary?: string;
};

export type LibraryBuildInput = {
  sourceTarget: string;
  sourcePath: string;
  dbId: string;
  dbTitle?: string;
};

export type LibraryPreviewRequest =
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

export type LibraryPreviewPayload =
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
