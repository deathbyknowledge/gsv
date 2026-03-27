import type {
  BufferEncoding,
  FileContent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { FsSearchMatch } from "../syscalls/search";

export type ExtendedMountStat = FsStat & { uid: number; gid: number };

export type FsSearchBackendResult = {
  matches: FsSearchMatch[];
  truncated?: boolean;
};

export interface MountBackend {
  handles(path: string): boolean;
  readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void>;
  appendFile(path: string, content: FileContent, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<ExtendedMountStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  search?(path: string, pattern: RegExp, include?: string): Promise<FsSearchBackendResult>;
  chmod?(path: string, mode: number): Promise<void>;
  chown?(path: string, uid?: number, gid?: number): Promise<void>;
  utimes?(path: string, atime: Date, mtime: Date): Promise<void>;
}
