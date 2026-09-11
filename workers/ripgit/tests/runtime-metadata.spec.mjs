import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

describe("repository deletion on the current Wrangler runtime", () => {
  let harness;
  const workerName = "ripgit-runtime-metadata";
  const root = resolve(import.meta.dirname, "..");
  const config = { name: workerName, main: resolve(root, "build/index.js"), compatibility_date: "2026-09-01",
    durable_objects: { bindings: [{ name: "REPOSITORY", class_name: "Repository" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Repository"] }],
  };
  beforeAll(async () => {
    harness = createTestHarness({ root, workers: [{ config }] });
    await harness.listen();
  });
  afterAll(async () => { await harness?.close(); });

  it("preserves runtime identity metadata through discovery, erasure, and restart", async () => {
    const installationId = `local-${crypto.randomUUID()}`;
    const worker = harness.getWorker(workerName);
    const created = await worker.fetch("https://ripgit.invalid/hyperspace/repos/alice/home/apply", {
      method: "POST", headers: { "x-gsv-installation-id": installationId, "content-type": "application/json" },
      body: JSON.stringify({ defaultBranch: "main", author: "alice", email: "fixture@example.invalid", message: "fixture",
        ops: [{ type: "put", path: "page.txt", contentBytes: [104, 105] }] }),
    });
    expect(created.status).toBe(200);
    await created.body?.cancel();
    const ids = await worker.listDurableObjectIds("REPOSITORY");
    expect(ids).toHaveLength(2);
    const inspect = async () => {
      const observations = [];
      for (const objectId of ids) {
        const response = await worker.fetch("https://ripgit.invalid/.gsv/discovery/inspect", { method: "POST",
          body: JSON.stringify({ objectId, kind: "ripgit", namespaceId: "a".repeat(32) }) });
        expect(response.status).toBe(200);
        observations.push(await response.json());
      }
      return observations.sort((a, b) => a.name.localeCompare(b.name));
    };
    const names = [`${installationId}/alice/home`, `installation-index:${installationId}`].sort();
    expect((await inspect()).map((item) => item.name)).toEqual(names);
    const input = { version: 1, installationId, operationId: "erase-local" };
    for (const action of ["quiesce", "erase"]) {
      const response = await worker.fetch(`https://ripgit.invalid/.gsv/installation/${action}`, { method: "POST", body: JSON.stringify(input) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ phase: action === "erase" ? "live-erased" : "quiesced" });
    }
    expect(await inspect()).toEqual(names.map((name) => ({ name, empty: true })));
    await harness.update({ root, workers: [{ config: { ...config, vars: { FIXTURE_RESTART: "second" } } }] });
    expect(await inspect()).toEqual(names.map((name) => ({ name, empty: true })));
    expect((await worker.listDurableObjectIds("REPOSITORY")).sort()).toEqual(ids.sort());
  });
});
