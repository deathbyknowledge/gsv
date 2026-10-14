import type { BrowserTabsBackend } from "@humansandmachines/gsv-browser/backend";
import type { BrowserCommand, FileStat, TargetFileSystem } from "@humansandmachines/gsv-browser/types";
import { normalizePath } from "@humansandmachines/gsv-browser/paths";
import { commandCatalog, helpText } from "@humansandmachines/gsv-browser/catalog";
import type { CloudInstance } from "@humansandmachines/gsv/protocol";

/** Synthetic browser metadata. Saved authentication state is deliberately absent. */
export class BrowserRuntimeFiles implements TargetFileSystem {
  constructor(private readonly browser: BrowserTabsBackend, private readonly instance: CloudInstance, private readonly commands: BrowserCommand[]) {}
  async read(path: string): Promise<Uint8Array> {
    let value: string;
    switch (normalizePath(path)) {
      case "/README.txt": value = `GSV cloud browser\n\n${helpText(this.commands)}\nFiles under /home/browser and /tmp last for this instance. Saved profiles retain website login state separately. Personal browser history, bookmarks, and extensions are unavailable.\n`; break;
      case "/proc/browser.json": value = JSON.stringify({ backend: "cloudflare", instanceId: this.instance.instanceId, expiresAt: this.instance.expiresAt, profileId: this.instance.profileId ?? null, width: 1280, height: 800 }); break;
      case "/proc/tabs.json": value = JSON.stringify(await this.browser.listTabs()); break;
      case "/proc/commands.json": value = commandCatalog(this.commands); break;
      default: throw new Error(`No such file: ${path}`);
    }
    return new TextEncoder().encode(value);
  }
  async list(path: string): Promise<{ files: string[]; directories: string[] }> {
    if (path === "/") return { files: ["README.txt"], directories: ["proc"] };
    if (path === "/proc") return { files: ["browser.json", "tabs.json", "commands.json"], directories: [] };
    throw new Error(`No such directory: ${path}`);
  }
  async stat(path: string): Promise<FileStat> {
    if (path === "/" || path === "/proc") return { path, isDirectory: true, isFile: false, size: 0 };
    const bytes = await this.read(path);
    return { path, isDirectory: false, isFile: true, size: bytes.byteLength, contentType: path.endsWith(".json") ? "application/json" : "text/plain" };
  }
  async exists(path: string): Promise<boolean> { return (await this.getAllPaths()).includes(normalizePath(path)); }
  async getAllPaths(): Promise<string[]> { return ["/", "/proc", "/README.txt", "/proc/browser.json", "/proc/tabs.json", "/proc/commands.json"]; }
  resolvePath(cwd: string, path: string): string { return normalizePath(path.startsWith("/") ? path : `${cwd}/${path}`); }
  async search(path: string, query: string): Promise<Array<{ path: string; line: number; content: string }>> {
    const matches: Array<{ path: string; line: number; content: string }> = [];
    for (const candidate of await this.getAllPaths()) {
      if (candidate === "/" || candidate === "/proc" || !(candidate === path || candidate.startsWith(path === "/" ? "/" : `${path}/`))) continue;
      new TextDecoder().decode(await this.read(candidate)).split("\n").forEach((content, i) => { if (content.includes(query)) matches.push({ path: candidate, line: i + 1, content }); });
    }
    return matches;
  }
  async write(): Promise<never> { throw new Error("Runtime filesystem is read-only"); }
  async append(): Promise<never> { throw new Error("Runtime filesystem is read-only"); }
  async delete(): Promise<never> { throw new Error("Runtime filesystem is read-only"); }
  async mkdir(): Promise<never> { throw new Error("Runtime filesystem is read-only"); }
  async copy(): Promise<never> { throw new Error("Runtime filesystem is read-only"); }
  async move(): Promise<never> { throw new Error("Runtime filesystem is read-only"); }
}
