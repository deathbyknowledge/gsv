import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { manualUpstream } from "./manual-upstream.mjs";

describe("versioned Manual imports", () => {
  let harness, upstream, worker;
  beforeAll(async () => {
    upstream = await manualUpstream();
    const root = resolve(import.meta.dirname, "..");
    harness = createTestHarness({ root, workers: [{ config: {
      name: "ripgit-manual-import", main: resolve(root, "build/index.js"), compatibility_date: "2026-09-01",
      durable_objects: { bindings: [{ name: "REPOSITORY", class_name: "Repository" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Repository"] }],
    } }] });
    await harness.listen();
    worker = harness.getWorker("ripgit-manual-import");
  });
  afterAll(async () => { await harness?.close(); await upstream?.close(); });

  async function importRevision(installation, revision) {
    const response = await worker.fetch("https://ripgit.invalid/hyperspace/repos/root/gsv-manual/import", {
      method: "POST", headers: { "x-gsv-installation-id": installation, "content-type": "application/json" },
      body: JSON.stringify({ author: "root", email: "root@gsv.local", message: "update", remoteUrl: upstream.url, remoteRef: revision }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  async function edit(installation) {
    const response = await worker.fetch("https://ripgit.invalid/hyperspace/repos/root/gsv-manual/apply", {
      method: "POST", headers: { "x-gsv-installation-id": installation, "content-type": "application/json" },
      body: JSON.stringify({ defaultBranch: "main", author: "root", email: "root@gsv.local", message: "local edit",
        ops: [{ type: "put", path: "index.md", contentBytes: [...new TextEncoder().encode("Local notes\n")] }] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).head;
  }

  it("imports an exact commit, advances and rolls back untouched copies, and avoids repeated downloads", async () => {
    const [old, next] = upstream.revisions;
    expect(await importRevision("inst_manual_clean", old)).toMatchObject({ head: old, changed: true, diverged: false });
    expect(await importRevision("inst_manual_clean", next)).toMatchObject({ head: next, changed: true, diverged: false });
    const fetched = upstream.fetches;
    expect(await importRevision("inst_manual_clean", next)).toMatchObject({ head: next, changed: false });
    expect(upstream.fetches).toBe(fetched);
    expect(await importRevision("inst_manual_clean", old)).toMatchObject({ head: old, changed: true, diverged: false });
  });

  it("preserves edits made while fetching the next revision", async () => {
    const [old, next] = upstream.revisions;
    await importRevision("inst_manual_edited", old);
    const held = upstream.holdNext();
    const update = importRevision("inst_manual_edited", next);
    await held.started;
    let local;
    try { local = await edit("inst_manual_edited"); } finally { held.release(); }
    expect(await update).toMatchObject({ head: local, changed: false, diverged: true, upstream_head: next });
    expect(await importRevision("inst_manual_edited", next)).toMatchObject({ head: local, changed: false, diverged: true });
  });
});
