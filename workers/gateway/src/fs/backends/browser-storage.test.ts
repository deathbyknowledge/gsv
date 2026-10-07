import { describe, expect, it, vi } from "vitest";
import type { BrowserProfile } from "@humansandmachines/gsv/protocol";
import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { BrowserStorageMountBackend, BROWSER_STORAGE_ROOT } from "./browser-storage";

const saved: BrowserProfile = { profileId: "saved", ownerUid: 1000, label: "Browser", state: "active", revision: 1, createdAt: 1, saveStatus: "saved", savedAt: 2, bytes: 100, storedBytes: 3 };
function fixture() {
  const forget = vi.fn(async () => {});
  const read = vi.fn(async () => ({ body: bodyFromBytes(new Uint8Array([1, 2, 3])), size: 3 }));
  return { forget, read, fs: new BrowserStorageMountBackend({ uid: 1000, gid: 1000, username: "owner", profile: async () => saved, read, forget }) };
}
describe("browser storage mount", () => {
  it("exposes metadata and opaque bytes only to the selected account", async () => {
    const { fs, read } = fixture();
    expect(await fs.readdir(BROWSER_STORAGE_ROOT)).toEqual(["owner"]);
    expect(await fs.exists(`${BROWSER_STORAGE_ROOT}/other/state.enc`)).toBe(false);
    const path = `${BROWSER_STORAGE_ROOT}/owner`;
    expect(await fs.readdir(path)).toEqual(["README.txt", "status.json", "sites.json", "state.enc"]);
    expect(JSON.parse(await fs.readFile(`${path}/status.json`))).toMatchObject({ account: "owner", saveStatus: "saved", bytes: 100 });
    expect(await fs.stat(`${path}/state.enc`)).toMatchObject({ size: 3, uid: 1000, mode: 0o400 });
    expect(read).not.toHaveBeenCalled();
    expect(await fs.readFileBuffer(`${path}/state.enc`)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(fs.writeFile(`${path}/state.enc`)).rejects.toThrow("EROFS");
  });
  it("uses the same forget operation for the snapshot and recursive account deletion", async () => {
    const { fs, forget } = fixture();
    const path = `${BROWSER_STORAGE_ROOT}/owner`;
    await expect(fs.rm(`${path}/status.json`)).rejects.toThrow("EROFS");
    await expect(fs.rm(path)).rejects.toThrow("EROFS");
    await fs.rm(`${path}/state.enc`);
    await fs.rm(path, { recursive: true });
    expect(forget.mock.calls).toEqual([["saved"], ["saved"]]);
  });
});
