export type FsReadArgs = {
  path: string;
  offset?: number;
  limit?: number;
};

export type FsImageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type FsReadResult =
  | {
      ok: true;
      content: string | FsImageContent[];
      path: string;
      lines?: number;
      size: number;
    }
  | { ok: true; path: string; files: string[]; directories: string[] }
  | { ok: false; error: string };

export type FsWriteArgs = {
  path: string;
  content: string;
};

export type FsWriteResult =
  | { ok: true; path: string; size: number }
  | { ok: false; error: string };

export type FsEditArgs = {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export type FsEditResult =
  | { ok: true; path: string; replacements: number }
  | { ok: false; error: string };

export type FsDeleteArgs = {
  path: string;
};

export type FsDeleteResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export type FsSearchArgs = {
  query: string;
  path?: string;
  include?: string;
};

export type FsSearchMatch = {
  path: string;
  line: number;
  content: string;
};

export type FsSearchResult =
  | { ok: true; matches: FsSearchMatch[]; count: number; truncated?: boolean }
  | { ok: false; error: string };

export type FsCopyEndpoint = {
  target?: string;
  path: string;
};

export type FsCopyArgs = {
  source: FsCopyEndpoint;
  destination: FsCopyEndpoint;
};

export type FsCopyResult =
  | {
      ok: true;
      source: Required<FsCopyEndpoint>;
      destination: Required<FsCopyEndpoint>;
      size: number;
      contentType?: string;
    }
  | { ok: false; error: string };

export type FsTransferStatArgs = {
  path: string;
};

export type FsTransferStatResult =
  | {
      ok: true;
      path: string;
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      contentType?: string;
    }
  | { ok: false; error: string };

export type FsTransferSendArgs = {
  path: string;
};

export type FsTransferSendResult =
  | {
      ok: true;
      path: string;
      size: number;
      contentType?: string;
    }
  | { ok: false; error: string };

export type FsTransferReceiveArgs = {
  path: string;
  contentType?: string;
};

export type FsTransferReceiveResult =
  | {
      ok: true;
      path: string;
      bytesWritten: number;
      contentType?: string;
    }
  | { ok: false; error: string };
