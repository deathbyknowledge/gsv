export type FilesRoute = {
  target: string;
  path: string;
  q: string;
  open: string;
};

export type FilesDevice = {
  deviceId: string;
  online?: boolean;
};

export type FilesContentItem =
  | { type: "image"; mimeType?: string; data?: string }
  | { type: "text"; text?: string };

export type FilesDirectoryResult = {
  ok: true;
  path?: string;
  files: string[];
  directories: string[];
};

export type FilesFileResult = {
  ok: true;
  path?: string;
  size?: number;
  content: string | FilesContentItem[];
};

export type FilesSearchMatch = {
  path: string;
  line?: number;
  content?: string;
};

export type FilesSearchResult = {
  ok: true;
  matches: FilesSearchMatch[];
  truncated?: boolean;
};

export type FilesState = {
  target: string;
  devices: FilesDevice[];
  currentPath: string;
  pathStyle: "absolute" | "relative";
  searchQuery: string;
  directoryResult: FilesDirectoryResult;
  filePath: string;
  fileResult: FilesFileResult | null;
  searchResult: FilesSearchResult;
  errorText: string;
};

export type FilesMutationResult = {
  target: string;
  path: string;
  q: string;
  open: string;
  statusText: string;
  errorText: string;
};

export type FilesSaveArgs = {
  target: string;
  path: string;
  currentPath: string;
  q: string;
  content: string;
};

export type FilesDeleteArgs = {
  target: string;
  path: string;
  currentPath: string;
  q: string;
};

export type FilesCreateArgs = {
  target: string;
  currentPath: string;
  name: string;
  q: string;
};

export interface FilesBackend {
  loadState(route: FilesRoute): Promise<FilesState>;
  saveFile(args: FilesSaveArgs): Promise<FilesMutationResult>;
  deletePath(args: FilesDeleteArgs): Promise<FilesMutationResult>;
  createFile(args: FilesCreateArgs): Promise<FilesMutationResult>;
}
