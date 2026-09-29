import { Buffer } from "node:buffer";
import { posix } from "node:path";
import type { BufferEncoding, FsStat, IFileSystem } from "just-bash";
import { normalizeSlackPath, SlackTargetFileSystem } from "./slack-target-fs";

/** The shell and fs.* read the same provider namespace. */
export class SlackShellFileSystem implements IFileSystem {
  constructor(private readonly resources: SlackTargetFileSystem) {}

  async readFile(path: string, options?: BufferEncoding | { encoding?: BufferEncoding | null }): Promise<string> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- just-bash's typed filesystem ABI accepts either an encoding string or an options record.
    const encoding = typeof options === "string" ? options : options?.encoding;
    return Buffer.from(await this.readFileBuffer(path)).toString(encoding ?? "utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resource = await this.resources.get(path);
    if (resource.kind !== "file") throw new Error(`Is a directory: ${path}`);
    return new TextEncoder().encode(resource.text);
  }

  async stat(path: string): Promise<FsStat> {
    const resource = await this.resources.get(path);
    return {
      isFile: resource.kind === "file",
      isDirectory: resource.kind === "directory",
      isSymbolicLink: false,
      mode: resource.kind === "file" ? 0o444 : 0o555,
      size: resource.kind === "file" ? new TextEncoder().encode(resource.text).byteLength : 0,
      mtime: new Date(0),
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No such Slack resource:")) return false;
      throw error;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const resource = await this.resources.get(path);
    if (resource.kind !== "directory") throw new Error(`Not a directory: ${path}`);
    const entries = await resource.list();
    return [
      ...entries.files.map((name) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })),
      ...entries.directories.map((name) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  resolvePath(base: string, path: string): string {
    return normalizeSlackPath(posix.resolve(base, path));
  }

  getAllPaths(): string[] { return []; }
  async lstat(path: string): Promise<FsStat> { return await this.stat(path); }
  async realpath(path: string): Promise<string> {
    await this.stat(path);
    return normalizeSlackPath(path);
  }
  async readlink(path: string): Promise<string> { throw new Error(`Not a symlink: ${path}`); }
  async mkdir(path: string): Promise<void> {
    if (path === "/") return;
    throw readOnly();
  }
  async writeFile(): Promise<void> { throw readOnly(); }
  async appendFile(): Promise<void> { throw readOnly(); }
  async rm(): Promise<void> { throw readOnly(); }
  async cp(): Promise<void> { throw readOnly(); }
  async mv(): Promise<void> { throw readOnly(); }
  async chmod(): Promise<void> { throw readOnly(); }
  async symlink(): Promise<void> { throw readOnly(); }
  async link(): Promise<void> { throw readOnly(); }
  async utimes(): Promise<void> { throw readOnly(); }
}

function readOnly(): Error {
  return new Error("Slack resources are read-only; use /tmp for shell scratch files and slack commands for mutations");
}
