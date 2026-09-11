export type FilesPathStyle = "absolute" | "relative";

export type FilesTarget = {
  id: string;
  label: string;
  online: boolean;
  platform: string;
  description: string;
  ownerUsername: string | null;
  lastSeenAt: number | null;
};

export type FilesContentItem =
  | { type: "image"; mimeType?: string; data?: string }
  | { type: "text"; text?: string };

export type FilesDirectoryEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
};

export type FilesDirectoryPayload = {
  ok: true;
  target: string;
  path: string;
  pathStyle: FilesPathStyle;
  entries: FilesDirectoryEntry[];
};

export type FilesFilePayload = {
  ok: true;
  target: string;
  path: string;
  directoryPath: string;
  pathStyle: FilesPathStyle;
  content: string | FilesContentItem[];
  size: number | null;
  lines: number | null;
};

export type FilesReadPayload = FilesDirectoryPayload | FilesFilePayload;

export type FilesSearchMatch = {
  path: string;
  line: number | null;
  content: string;
};

export type FilesSearchPayload = {
  ok: true;
  target: string;
  path: string;
  query: string;
  matches: FilesSearchMatch[];
  count: number;
  truncated: boolean;
};

export type FilesWritePayload = {
  ok: true;
  target: string;
  path: string;
  size: number | null;
};

export type FilesDeletePayload = {
  ok: true;
  target: string;
  path: string;
};

export type FilesErrorPayload = {
  ok: false;
  target: string;
  path?: string;
  error: string;
};
