import type {
  BufferEncoding,
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend } from "../mount";
import { normalizePath } from "../utils";

const COMMAND_DIRECTORIES = ["/bin", "/usr/bin"];

/**
 * /bin and /usr/bin belong to the gsv shell's built-in commands, never to storage.
 *
 * just-bash runs a built-in when no PATH entry holds a file of that name and
 * /usr/bin does not exist. These paths therefore always read as absent and
 * refuse writes: looking a command up here costs no storage round trip, and no
 * stored file can hide every command.
 */
export class CommandDirectoriesBackend implements MountBackend {
  handles(path: string): boolean {
    const normalized = normalizePath(path);
    return COMMAND_DIRECTORIES.some((directory) => (
      normalized === directory || normalized.startsWith(`${directory}/`)
    ));
  }

  async readFile(
    path: string,
    _options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ): Promise<string> {
    throw notFoundError("open", path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    throw notFoundError("open", path);
  }

  async writeFile(path: string, _content: FileContent): Promise<void> {
    throw readOnlyError("open", path);
  }

  async appendFile(path: string, _content: FileContent): Promise<void> {
    throw readOnlyError("open", path);
  }

  async exists(_path: string): Promise<boolean> {
    return false;
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    throw notFoundError("stat", path);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    throw readOnlyError("mkdir", path);
  }

  async readdir(path: string): Promise<string[]> {
    throw notFoundError("scandir", path);
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    throw readOnlyError("unlink", path);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw readOnlyError("symlink", linkPath);
  }

  async readlink(path: string): Promise<string> {
    throw notFoundError("readlink", path);
  }

  async search(path: string): Promise<FsSearchBackendResult> {
    throw notFoundError("scandir", path);
  }

  async chmod(path: string): Promise<void> {
    throw readOnlyError("chmod", path);
  }

  async chown(path: string): Promise<void> {
    throw readOnlyError("chown", path);
  }

  async utimes(path: string): Promise<void> {
    throw readOnlyError("utimes", path);
  }
}

function notFoundError(operation: string, path: string): Error {
  return new Error(`ENOENT: no such file or directory, ${operation} '${normalizePath(path)}'`);
}

function readOnlyError(operation: string, path: string): Error {
  return new Error(`EROFS: read-only file system, ${operation} '${normalizePath(path)}'`);
}
