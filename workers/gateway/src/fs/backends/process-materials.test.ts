import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ProcessScope } from "@humansandmachines/gsv/protocol";
import { GsvFs } from "../gsv-fs";
import { ProcessMaterialsBackend } from "./process-materials";

describe("helper material filesystem", () => {
  it("has no fallthrough to private mounts, traversal, writes or links, and fences open streams", async () => {
    let active = true;
    const scope: ProcessScope = { id: "scope:one", ownerUid: 1000, rootPid: "proc:one", revision: 1, state: "active", createdAtMs: 10,
      used: { processes: 1, generations: 0, messages: 0 }, policy: { conversations: [], resources: [], materials: [{ name: "help.txt", text: "selected content" }],
        expiresAtMs: Date.now() + 60_000, budgets: { processes: 1, generations: 4, messages: 0 } } };
    const backend = new ProcessMaterialsBackend(scope, () => { if (!active) throw new Error("revoked"); });
    const fs = new GsvFs(env.STORAGE, { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/materials" }, undefined, "proc:one", null, null, backend);
    expect(await fs.readdir("/")).toEqual(["materials"]);
    expect(await fs.readFile("/materials/help.txt")).toBe("selected content");
    for (const path of ["/etc/shadow", "/sys/config", "/proc/other/history", "/home/owner/context.d/private.md", "/materials/../../etc/passwd"]) {
      await expect(fs.readFile(path)).rejects.toThrow("outside");
    }
    await expect(fs.writeFile("/materials/help.txt", "replacement")).rejects.toThrow("immutable");
    await expect(fs.symlink("/home/owner", "/materials/link")).rejects.toThrow("immutable");
    const opened = await fs.openFile("/materials/help.txt");
    active = false;
    await expect(opened.body!.getReader().read()).rejects.toThrow("revoked");
    await expect(fs.readdir("/")).rejects.toThrow("revoked");
  });
});
