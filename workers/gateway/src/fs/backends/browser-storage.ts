import type { RmOptions } from "just-bash";
import type { BinaryBody, BrowserProfile } from "@humansandmachines/gsv/protocol";
import { bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { ExtendedMountStat, MountBackend, OpenFileOptions, OpenFileResult } from "../mount";
import { normalizePath } from "../utils";

export const BROWSER_STORAGE_ROOT = "/var/lib/gsv/browser";
export type BrowserStorageAccess = {
  uid: number; gid: number; username: string;
  profile(): Promise<BrowserProfile | null>;
  read(profileId: string): Promise<{ body: BinaryBody; size: number } | null>;
  forget(profileId: string): Promise<void>;
};
const README = `Saved browser state belongs to this local account and is reused automatically.
status.json reports the last committed save and the latest attempt, including sites that could not be saved.
sites.json reports storage sizes and counts, never cookies or login values.
state.enc is the encrypted snapshot. It is opaque and read-only; its key is held by the owning instance service.
Delete state.enc, or recursively remove this account directory, to forget saved logins.
Forgetting stops the browser using this state, fences pending saves, and erases the snapshots and key. Physical cleanup may finish after the directory disappears.
The next ordinary browser start creates fresh state. Copying state.enc alone is not a portable backup.
`;

/** A projection of the instance service, with no second copy of browser state. */
export class BrowserStorageMountBackend implements MountBackend {
  readonly accountPath: string;
  constructor(private readonly access: BrowserStorageAccess) { this.accountPath = `${BROWSER_STORAGE_ROOT}/${access.username}`; }
  handles(path: string): boolean { const p = normalizePath(path); return p === "/var/lib/gsv" || p === BROWSER_STORAGE_ROOT || p.startsWith(`${BROWSER_STORAGE_ROOT}/`); }
  private missing(path: string): Error { return new Error(`ENOENT: no such file or directory, '${path}'`); }
  private async entry(path: string): Promise<{ saved: BrowserProfile | null; name: string; directory: boolean }> {
    const p = normalizePath(path);
    const saved = await this.access.profile();
    if (p === "/var/lib/gsv" || p === BROWSER_STORAGE_ROOT) return { saved, name: p, directory: true };
    if (!saved || (p !== this.accountPath && !p.startsWith(`${this.accountPath}/`))) throw this.missing(p);
    if (p === this.accountPath) return { saved, name: p, directory: true };
    const name = p.slice(this.accountPath.length + 1);
    if (!["README.txt", "status.json", "sites.json", "state.enc"].includes(name) || (name === "state.enc" && !saved.savedAt)) throw this.missing(p);
    return { saved, name, directory: false };
  }
  async exists(path: string): Promise<boolean> {
    try { await this.entry(path); return true; }
    catch (error) { if (error instanceof Error && error.message.startsWith("ENOENT:")) return false; throw error; }
  }
  async readdir(path: string): Promise<string[]> {
    const { saved, name, directory } = await this.entry(path);
    if (!directory) throw new Error(`ENOTDIR: '${path}'`);
    if (name === "/var/lib/gsv") return ["browser"];
    if (name === BROWSER_STORAGE_ROOT) return saved ? [this.access.username] : [];
    return ["README.txt", "status.json", "sites.json", ...(saved?.savedAt ? ["state.enc"] : [])];
  }
  private text(name: string, saved: BrowserProfile): string {
    if (name === "README.txt") return README;
    const { saveStatus, savedAt, attemptedAt, durationMs, bytes, storedBytes, limitBytes, error, diagnosticRef, activeInstanceId, issues } = saved;
    return `${JSON.stringify(name === "sites.json" ? { measured: Boolean(saved.usage), usage: saved.usage ?? null, issues }
      : { account: this.access.username, saveStatus, savedAt, attemptedAt, durationMs, bytes, storedBytes, limitBytes, error, diagnosticRef, activeInstanceId, issues }, null, 2)}\n`;
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    const { saved, name, directory } = await this.entry(path);
    if (directory || !saved) throw new Error(`EISDIR: '${path}'`);
    if (name !== "state.enc") return new TextEncoder().encode(this.text(name, saved));
    const state = await this.access.read(saved.profileId);
    if (!state) throw this.missing(path);
    return bodyToBytes(state.body, 32 * 1024 * 1024 + 65536);
  }
  async readFile(path: string): Promise<string> { return new TextDecoder().decode(await this.readFileBuffer(path)); }
  async openFile(path: string, options?: OpenFileOptions): Promise<OpenFileResult | undefined> {
    // Conditional and range reads use GsvFs's bounded generated-file fallback.
    if (options?.conditions || options?.range) return undefined;
    const { saved, name, directory } = await this.entry(path);
    if (directory || !saved || name !== "state.enc") return undefined;
    const state = await this.access.read(saved.profileId);
    if (!state) throw this.missing(path);
    return { body: state.body.stream, size: state.size, totalSize: state.size, mtime: new Date(saved.savedAt!), status: 200, contentType: "application/octet-stream" };
  }
  async stat(path: string): Promise<ExtendedMountStat> {
    const { saved, name, directory } = await this.entry(path);
    let size = directory ? 0 : new TextEncoder().encode(this.text(name, saved!)).byteLength;
    if (name === "state.enc") {
      if (saved!.storedBytes !== undefined) size = saved!.storedBytes;
      else {
        const state = await this.access.read(saved!.profileId);
        if (!state) throw this.missing(path);
        size = state.size; await state.body.stream.cancel();
      }
    }
    return { isFile: !directory, isDirectory: directory, isSymbolicLink: false, size, mode: directory ? 0o500 : 0o400, uid: this.access.uid, gid: this.access.gid, mtime: new Date(saved?.savedAt ?? saved?.createdAt ?? 0) };
  }
  async rm(path: string, options?: RmOptions): Promise<void> {
    const p = normalizePath(path);
    if (options?.force && !await this.exists(p)) return;
    const { saved, name } = await this.entry(p);
    if (saved && (name === "state.enc" || (p === this.accountPath && options?.recursive))) { await this.access.forget(saved.profileId); return; }
    throw new Error(`EROFS: only state.enc or the account directory can be removed, '${p}'`);
  }
  async writeFile(path: string): Promise<never> { throw new Error(`EROFS: saved browser state is read-only, '${path}'`); }
  async appendFile(path: string): Promise<never> { return this.writeFile(path); }
  async mkdir(path: string): Promise<never> { return this.writeFile(path); }
}
