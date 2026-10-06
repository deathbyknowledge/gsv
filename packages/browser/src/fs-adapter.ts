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

type ReadFileOptions = { encoding?: BufferEncoding | null };
type WriteFileOptions = { encoding?: BufferEncoding };

export class JustBashFileSystemAdapter implements IFileSystem {
  constructor(private readonly fs: TargetFileSystem) {}

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const bytes = await this.fs.read(path);
    const encoding = isEncodingOption(options) ? options : options?.encoding;
    if (encoding === "base64") {
      return bytesToBase64(bytes);
    }
    if (encoding === "hex") return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    if (encoding === "binary" || encoding === "latin1" || encoding === "ascii") {
      return Array.from(bytes, byte => String.fromCharCode(encoding === "ascii" ? byte & 0x7f : byte)).join("");
    }
    return new TextDecoder().decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return await this.fs.read(path);
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.fs.write(path, fileContentToBytes(content, isEncodingOption(options) ? options : options?.encoding));
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.fs.append(path, fileContentToBytes(content, isEncodingOption(options) ? options : options?.encoding));
  }

  async exists(path: string): Promise<boolean> {
    return await this.fs.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    if (!await this.fs.exists(path)) throw new Error(`ENOENT: no such file or directory: ${path}`);
    const stat = await this.fs.stat(path);
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: false,
      mode: stat.isDirectory ? 0o755 : 0o644,
      size: stat.size,
      mtime: new Date(),
      // Browser filesystems have no hard links or symlinks, so canonical paths identify files.
      identity: this.fs.resolvePath("/", path),
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

function isEncodingOption(options?: ReadFileOptions | BufferEncoding): options is BufferEncoding {
  return typeof options === "string";
}

function fileContentToBytes(content: FileContent, encoding?: BufferEncoding): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (encoding === "binary" || encoding === "latin1" || encoding === "ascii") {
    return Uint8Array.from(content, char => char.charCodeAt(0) & 0xff);
  }
  if (encoding === "base64") return Uint8Array.from(atob(content), char => char.charCodeAt(0));
  if (encoding === "hex") return Uint8Array.from(content.match(/.{2}/g) ?? [], byte => parseInt(byte, 16));
  return new TextEncoder().encode(content);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
