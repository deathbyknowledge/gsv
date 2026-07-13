import type {
  BufferEncoding,
  FileContent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { FsSearchMatch } from "../syscalls/search";

export type ExtendedMountStat = FsStat & { uid: number; gid: number; contentType?: string };

export type FsSearchBackendResult = {
  matches: FsSearchMatch[];
  truncated?: boolean;
};

export type OpenFileConditions = {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  mtimeBefore?: Date;
  mtimeAfter?: Date;
};

export type OpenFileRangeRequest = {
  offset: number;
  length?: number;
} | {
  suffix: number;
};

export type OpenFileOptions = {
  conditions?: OpenFileConditions;
  range?: OpenFileRangeRequest;
};

export type OpenFileRange = {
  offset: number;
  length: number;
  total: number;
};

export type OpenFileResult = {
  body?: ReadableStream<Uint8Array>;
  size: number;
  totalSize: number;
  mtime: Date;
  status: 200 | 206 | 304 | 412;
  contentType?: string;
  etag?: string;
  range?: OpenFileRange;
  writeHttpMetadata?: (headers: Headers) => void;
};

export type WriteFileStreamOptions = {
  expectedSize: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  signal?: AbortSignal;
};

export type WriteFileOptions = {
  encoding?: BufferEncoding;
  contentType?: string;
};

export type WriteFileStreamResult = {
  size: number;
  streamed: boolean;
};

export interface MountBackend {
  handles(path: string): boolean;
  readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  /** Return undefined to use GsvFs's buffered fallback. */
  openFile?(path: string, options?: OpenFileOptions): Promise<OpenFileResult | undefined>;
  writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
  /** Return undefined without consuming content to use GsvFs's buffered fallback. */
  writeFileStream?(
    path: string,
    content: ReadableStream<Uint8Array>,
    options: WriteFileStreamOptions,
  ): Promise<WriteFileStreamResult | undefined>;
  appendFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<ExtendedMountStat>;
  lstat?(path: string): Promise<ExtendedMountStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  symlink?(target: string, linkPath: string): Promise<void>;
  readlink?(path: string): Promise<string>;
  search?(
    path: string,
    query: string,
    include?: string,
    signal?: AbortSignal,
  ): Promise<FsSearchBackendResult>;
  chmod?(path: string, mode: number): Promise<void>;
  chown?(path: string, uid?: number, gid?: number): Promise<void>;
  utimes?(path: string, atime: Date, mtime: Date): Promise<void>;
}
