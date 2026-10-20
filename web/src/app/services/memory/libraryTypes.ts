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

export type LibraryMutationResult = {
  db: string;
  openPath: string;
};

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

export type LibrarySavePageInput = {
  createOnly?: boolean;
  expectedMarkdown?: string;
  db: string;
  path: string;
  markdown: string;
};
