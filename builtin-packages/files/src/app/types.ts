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

export type FilesDeviceListResult = {
  devices: FilesDevice[];
  errorText: string;
};

export type FilesDirectoryLoadArgs = {
  target: string;
  path: string;
};

export type FilesDirectoryLoadResult = {
  target: string;
  currentPath: string;
  pathStyle: "absolute" | "relative";
  directoryResult: FilesDirectoryResult;
  filePath: string;
  errorText: string;
};

export type FilesFileLoadArgs = {
  target: string;
  path: string;
};

export type FilesFileLoadResult = {
  target: string;
  filePath: string;
  fileResult: FilesFileResult | null;
  directoryPath: string;
  directoryResult: FilesDirectoryResult | null;
  pathStyle: "absolute" | "relative";
  errorText: string;
};

export type FilesSearchLoadArgs = {
  target: string;
  path: string;
  q: string;
};

export type FilesSearchLoadResult = {
  target: string;
  path: string;
  q: string;
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

export type FilesMutationPending = {
  kind: "save" | "delete" | "create";
  path: string;
  label: string;
};

export type FilesPendingNavigation = {
  kind: "directory" | "file" | "search" | "path" | "target";
  entryKind: "directory" | "file" | "search" | "";
  path: string;
  label: string;
};

export interface FilesBackend {
  listDevices(): Promise<FilesDeviceListResult>;
  loadDirectory(args: FilesDirectoryLoadArgs): Promise<FilesDirectoryLoadResult>;
  loadFile(args: FilesFileLoadArgs): Promise<FilesFileLoadResult>;
  searchFiles(args: FilesSearchLoadArgs): Promise<FilesSearchLoadResult>;
  saveFile(args: FilesSaveArgs): Promise<FilesMutationResult>;
  deletePath(args: FilesDeleteArgs): Promise<FilesMutationResult>;
  createFile(args: FilesCreateArgs): Promise<FilesMutationResult>;
}
