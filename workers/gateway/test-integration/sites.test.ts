import { GSVClient, type SiteManifest, type SitePublishArgs } from "@humansandmachines/gsv";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

describe("static publication from a clean installation", () => {
  let harness: TestHarness;
  let url: string;
  let owner: GSVClient;
  beforeAll(async () => {
    harness = createGatewayTestHarness({ sites: true });
    url = webSocketUrl((await harness.listen()).url);
  });
  afterAll(async () => { owner?.close(); await harness.close(); });

  it("publishes through ordinary syscalls, survives runtime reload, and unpublishes through the native command", async () => {
    await new GSVClient().requestOnce(url, "sys.setup", { onboardingToken: "integration-onboarding-default",
      username: "site-owner", password: "publication-password", rootPassword: "publication-root-password" });
    owner = new GSVClient({ url, password: "publication-password", peer: { id: "site-publisher" } });
    await owner.connect();
    const { site } = await owner.site.create({ slug: "canvas-game" });
    const releaseId = crypto.randomUUID();
    const contents = { "index.html": `<canvas id="game"></canvas><script src="/_r/${releaseId}/game.js"></script>`,
      "game.js": 'document.querySelector("canvas").getContext("2d").fillRect(10, 10, 40, 40);' };
    const files: SiteManifest["files"] = [];
    for (const [path, content] of Object.entries(contents)) {
      expect(await owner.fs.write({ path: `/tmp/site-build/${path}`, content })).toMatchObject({ ok: true });
      const bytes = new TextEncoder().encode(content);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      files.push({ path, size: bytes.length, sha256 });
    }
    const builder = await owner.proc.spawn({ label: "Site builder", runAs: "crew" });
    if (!builder.ok) throw new Error(builder.error);
    const publishArgs: SitePublishArgs = { siteId: site.id, expectedRevision: 0, releaseId, outputPath: "/tmp/site-build",
      manifest: { version: 1, title: "Canvas game", description: "A tiny browser game", entry: "index.html", routing: "static",
        source: { repo: "site-owner/demo", revision: "a".repeat(40) }, files } };
    expect(await owner.codemode.run({ pid: builder.pid, code: "return await site.publish(args);", args: publishArgs }))
      .toMatchObject({ status: "completed", result: { publication: { revision: 1, releaseId } } });
    const sql = await harness.getWorker("gsv").getDurableObjectStorage("KERNEL", { name: "inst_integration_default" });
    await sql.exec("DELETE FROM group_capabilities WHERE gid = 100 AND capability = 'site.*'");
    try {
      expect(await owner.codemode.run({ pid: builder.pid, code: "return await site.list();" }))
        .toMatchObject({ status: "failed", error: expect.stringContaining("Permission denied") });
    } finally {
      await sql.exec("INSERT OR IGNORE INTO group_capabilities (gid, capability) VALUES (100, 'site.*')");
    }
    owner.close();
    await harness.update((options) => options);
    const share = await harness.fetch("/public/canvas-game");
    expect(share.status).toBe(200);
    expect(await share.text()).toContain('property="og:title" content="Canvas game"');
    const assetUrl = `${site.origin}/_r/${releaseId}/game.js`;
    const asset = await harness.getWorker("gsv").fetch(assetUrl);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe(contents["game.js"]);
    const websocket = await harness.getWorker("gsv").fetch(`${site.origin}/ws`, { headers: { upgrade: "websocket" } });
    expect(websocket.status).toBe(404);
    await websocket.body?.cancel();
    owner = new GSVClient({ url, password: "publication-password", peer: { id: "site-unpublisher" } });
    await owner.connect();
    const restored = await owner.site.get({ siteId: site.id });
    expect(restored.manifest?.source).toEqual({ repo: "site-owner/demo", revision: "a".repeat(40) });
    const listed = await owner.shell.exec({ input: "sites list" });
    expect(listed).toMatchObject({ status: "completed", exitCode: 0 });
    expect(listed.output).toContain("/public/canvas-game");
    expect(await owner.shell.exec({ input: "sites unpublish canvas-game" }))
      .toMatchObject({ status: "completed", exitCode: 0, output: "Unpublished canvas-game\n" });
    expect((await owner.site.get({ siteId: site.id })).manifest).toEqual(restored.manifest);
    const removed = await harness.getWorker("gsv").fetch(assetUrl);
    expect(removed.status).toBe(404);
    await removed.body?.cancel();
    const hidden = await harness.fetch("/public/canvas-game");
    expect(hidden.status).toBe(404);
    await hidden.body?.cancel();
  });
});
