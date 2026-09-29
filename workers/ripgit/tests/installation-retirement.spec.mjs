import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Repository installation retirement", () => {
  let miniflare;
  let remoteStarted;
  let releaseRemote;

  beforeAll(() => {
    miniflare = new Miniflare({
      modules: true,
      modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
      scriptPath: "build/index.js", modulesRoot: "build", compatibilityDate: "2026-03-18",
      durableObjects: { REPOSITORY: { className: "Repository", useSQLite: true } },
      durableObjectsPersist: false,
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "remote.invalid") throw new Error("Unexpected fixture network request");
        remoteStarted?.resolve();
        await releaseRemote?.promise;
        return miniflare.dispatchFetch(`http://ripgit${url.pathname}${url.search}`, {
          method: request.method, headers: { "x-gsv-installation-id": "source" },
          body: request.method === "GET" ? undefined : await request.arrayBuffer(),
        });
      },
    });
  });

  afterAll(async () => { await miniflare.dispose(); });

  it("erases all recorded repository content and preserves the replacement", async () => {
    await create("retired", "home");
    const other = await create("replacement", "home");
    const request = { version: 1, installationId: "retired", operationId: "delete-retired" };
    expect(await lifecycle("quiesce", request)).toMatchObject({ phase: "quiesced", pendingResources: 0 });
    expect(await lifecycle("erase", request)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect(await lifecycle("erase", request)).toMatchObject({ phase: "live-erased" });
    expect(await inspect("retired/alice/home")).toEqual({ name: "retired/alice/home", empty: true });
    const response = await miniflare.dispatchFetch("http://ripgit/hyperspace/repos/alice/home/refs", { headers: { "x-gsv-installation-id": "replacement" } });
    expect((await response.json()).heads.main).toBe(other);
    const late = await miniflare.dispatchFetch("http://ripgit/hyperspace/repos/alice/new/refs", { headers: { "x-gsv-installation-id": "retired" } });
    expect(late.status).toBeGreaterThanOrEqual(400);
    await late.body?.cancel();
  });

  it("resumes bounded repository batches", async () => {
    for (let index = 0; index < 17; index++) await create("batched", `repo${index}`);
    const request = { version: 1, installationId: "batched", operationId: "delete-batched" };
    expect(await lifecycle("quiesce", request)).toMatchObject({ phase: "quiescing", pendingResources: 1 });
    expect(await lifecycle("quiesce", request)).toMatchObject({ phase: "quiesced", pendingResources: 0 });
    expect(await lifecycle("erase", request)).toMatchObject({ phase: "quiesced", pendingResources: 1 });
    expect(await lifecycle("erase", request)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect((await inspect("batched/alice/repo16")).empty).toBe(true);
  });

  it("fences a late remote import after its installation has been erased", async () => {
    await create("source", "home");
    await create("late-import", "home");
    remoteStarted = Promise.withResolvers();
    releaseRemote = Promise.withResolvers();
    const pending = miniflare.dispatchFetch("http://ripgit/hyperspace/repos/alice/home/import", {
      method: "POST", headers: { "x-gsv-installation-id": "late-import", "content-type": "application/json" },
      body: JSON.stringify({ remoteUrl: "https://remote.invalid/alice/home", remoteRef: "main", author: "alice", email: "alice@example.invalid", message: "fixture import" }),
    });
    await remoteStarted.promise;
    const request = { version: 1, installationId: "late-import", operationId: "delete-late" };
    await lifecycle("quiesce", request);
    await lifecycle("erase", request);
    releaseRemote.resolve();
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.body?.cancel();
    expect((await inspect("late-import/alice/home")).empty).toBe(true);
    remoteStarted = undefined;
    releaseRemote = undefined;
  });

  it("ordinary repository deletion retains ownership and allows a fresh repository", async () => {
    await create("ordinary", "home");
    const removed = await miniflare.dispatchFetch("http://ripgit/alice/home", { method: "DELETE", headers: { "x-gsv-installation-id": "ordinary", "x-ripgit-actor-name": "alice" } });
    expect(removed.status).toBe(200);
    await removed.body?.cancel();
    expect(await inspect("ordinary/alice/home")).toEqual({ name: "ordinary/alice/home", empty: true });
    await create("ordinary", "home");
  });

  it("discovers repository and index ownership from their physical addresses without a name hint", async () => {
    await create("discovered", "home");
    const namespace = await miniflare.getDurableObjectNamespace("REPOSITORY");
    for (const name of ["discovered/alice/home", "installation-index:discovered"]) {
      const response = await miniflare.dispatchFetch("http://ripgit/.gsv/discovery/inspect", {
        method: "POST", body: JSON.stringify({ kind: "ripgit", namespaceId: "a".repeat(32), objectId: namespace.idFromName(name).toString() }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ name, empty: false });
    }
  });

  async function create(installationId, repo) {
    const response = await miniflare.dispatchFetch(`http://ripgit/hyperspace/repos/alice/${repo}/apply`, {
      method: "POST", headers: { "x-gsv-installation-id": installationId, "content-type": "application/json" },
      body: JSON.stringify({ defaultBranch: "main", author: "alice", email: "alice@example.invalid", message: "fixture commit", ops: [{ type: "put", path: "page.txt", contentBytes: [104, 105] }] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).head;
  }

  async function lifecycle(action, request) {
    const response = await miniflare.dispatchFetch(`http://ripgit/.gsv/installation/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function inspect(name) {
    const namespace = await miniflare.getDurableObjectNamespace("REPOSITORY");
    const response = await miniflare.dispatchFetch("http://ripgit/.gsv/discovery/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objectId: namespace.idFromName(name).toString(), name }) });
    expect(response.status).toBe(200);
    return response.json();
  }
});
