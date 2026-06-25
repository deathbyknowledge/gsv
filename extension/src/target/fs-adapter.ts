import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";
import type { TargetFileSystem } from "./types";
import { dirname } from "../shared/paths";

type ReadFileOptions = { encoding?: BufferEncoding | null };
type WriteFileOptions = { encoding?: BufferEncoding };

export class JustBashFileSystemAdapter implements IFileSystem {
  constructor(private readonly fs: TargetFileSystem) {}

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const bytes = await this.fs.read(path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding === "base64") {
      return bytesToBase64(bytes);
    }
    return new TextDecoder().decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return await this.fs.read(path);
  }

  async writeFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.fs.mkdir(dirname(path));
    await this.fs.write(path, fileContentToBytes(content));
  }

  async appendFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.fs.mkdir(dirname(path));
    await this.fs.append(path, fileContentToBytes(content));
  }

  async exists(path: string): Promise<boolean> {
    return await this.fs.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    const stat = await this.fs.stat(path);
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: false,
      mode: stat.isDirectory ? 0o755 : 0o644,
      size: stat.size,
      mtime: new Date(),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    return await this.stat(path);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    await this.fs.mkdir(path);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.fs.list(path);
    return [...entries.directories, ...entries.files].sort();
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const entries = await this.fs.list(path);
    return [
      ...entries.directories.map((name) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false })),
      ...entries.files.map((name) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })),
    ].sort((left, right) => left.name.localeCompare(right.name));
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    await this.fs.delete(path);
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    await this.fs.copy(src, dest);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.fs.move(src, dest);
  }

  resolvePath(base: string, path: string): string {
    return this.fs.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return [];
  }

  async chmod(_path: string, _mode: number): Promise<void> {}

  async symlink(): Promise<void> {
    throw new Error("symlink is not supported");
  }

  async link(): Promise<void> {
    throw new Error("hard links are not supported");
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`Not a symlink: ${path}`);
  }

  async realpath(path: string): Promise<string> {
    await this.fs.stat(path);
    return this.fs.resolvePath("/", path);
  }

  async utimes(): Promise<void> {}
}

function fileContentToBytes(content: FileContent): Uint8Array {
  const value = content as unknown;
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new TextEncoder().encode(String(value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
