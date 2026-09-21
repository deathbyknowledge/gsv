import type { ProcessScope } from "@humansandmachines/gsv/protocol";
import type { ExtendedMountStat, FsSearchBackendResult, MountBackend, OpenFileResult } from "../mount";
import { matchPathGlob, normalizePath } from "../utils";

/** A closed filesystem: no fallthrough to account homes, devices, /sys, or R2. */
export class ProcessMaterialsBackend implements MountBackend {
  constructor(private readonly scope: ProcessScope, private readonly assertCurrent: () => void) {}

  handles(): boolean { return true; }

  private material(path: string) {
    this.assertCurrent();
    const normalized = normalizePath(path);
    const material = this.scope.policy.materials.find((entry) => `/materials/${entry.name}` === normalized);
    if (!material) throw new Error(`EACCES: path is outside the selected helper materials: ${normalized}`);
    return material;
  }

  async readFile(path: string): Promise<string> { return this.material(path).text; }
  async readFileBuffer(path: string): Promise<Uint8Array> { return new TextEncoder().encode(this.material(path).text); }
  async openFile(path: string): Promise<OpenFileResult> {
    const bytes = new TextEncoder().encode(this.material(path).text);
    return {
      body: new ReadableStream<Uint8Array>({ pull: (controller) => {
        this.assertCurrent();
        controller.enqueue(bytes);
        controller.close();
      } }, { highWaterMark: 0 }),
      size: bytes.byteLength, totalSize: bytes.byteLength, mtime: new Date(this.scope.createdAtMs), status: 200,
      contentType: "text/plain; charset=utf-8", etag: `"${this.scope.id}/${normalizePath(path)}"`,
    };
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    this.assertCurrent();
    const normalized = normalizePath(path);
    const directory = normalized === "/" || normalized === "/materials";
    const size = directory ? 0 : new TextEncoder().encode(this.material(normalized).text).byteLength;
    return { isFile: !directory, isDirectory: directory, isSymbolicLink: false, mode: directory ? 0o500 : 0o400,
      size, mtime: new Date(this.scope.createdAtMs), uid: this.scope.ownerUid, gid: this.scope.ownerUid,
      identity: `${this.scope.id}:${normalized}`, contentType: "text/plain; charset=utf-8" };
  }
  async lstat(path: string): Promise<ExtendedMountStat> { return this.stat(path); }
  async exists(path: string): Promise<boolean> {
    this.assertCurrent();
    const normalized = normalizePath(path);
    return normalized === "/" || normalized === "/materials" || this.scope.policy.materials.some((entry) => `/materials/${entry.name}` === normalized);
  }
  async readdir(path: string): Promise<string[]> {
    this.assertCurrent();
    const normalized = normalizePath(path);
    if (normalized === "/") return ["materials"];
    if (normalized === "/materials") return this.scope.policy.materials.map((entry) => entry.name).sort();
    throw new Error("EACCES: directory is outside the selected helper materials");
  }
  async search(path: string, query: string, include?: string, signal?: AbortSignal): Promise<FsSearchBackendResult> {
    this.assertCurrent();
    signal?.throwIfAborted();
    const root = normalizePath(path);
    await this.stat(root);
    this.assertCurrent();
    const matches: FsSearchBackendResult["matches"] = [];
    for (const material of this.scope.policy.materials) {
      const file = `/materials/${material.name}`;
      if (root !== "/" && root !== "/materials" && file !== root) continue;
      if (include && !matchPathGlob(include, file.slice(1))) continue;
      for (const [index, line] of material.text.split("\n").entries()) {
        if (!line.includes(query)) continue;
        matches.push({ path: file, line: index + 1, content: line });
        if (matches.length >= 500) return { matches, truncated: true };
      }
    }
    this.assertCurrent();
    return { matches };
  }
  async writeFile(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
  async appendFile(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
  async mkdir(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
  async rm(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
  async chmod(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
  async chown(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
  async utimes(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
  async symlink(): Promise<never> { throw new Error("EROFS: helper materials are immutable"); }
}
