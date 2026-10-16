import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { SiteManifest } from "@humansandmachines/gsv/protocol";
import { GsvFs } from "../fs/gsv-fs";
import { R2MountBackend } from "../fs/backends/r2";
import { createInstallationStorage } from "../installation/storage";
import { readSitePublication, siteReleasePrefix } from "../sites/storage";
import { servePublishedSite } from "../sites/http";
import { testPeer } from "../test-support/peers";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { KernelContext } from "./context";
import { SiteStore } from "./site-store";
import { handleSiteCreate, handleSiteGet, handleSitePublish, handleSiteUnpublish } from "./sites";

const OWNER = { uid: 1000, gid: 1000, gids: [100, 1000], username: "alice", home: "/home/alice", cwd: "/home/alice" };
const SOURCE_REVISION = "a".repeat(40);

describe("site publication", () => {
  it("retains a verified source revision, streams immutable output, and fences overlapping unpublish", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = context(sql);
      const created = await handleSiteCreate({ slug: "demo" }, ctx);
      const manifest = await output(ctx, "<h1>first</h1>");
      const releaseId = crypto.randomUUID();
      const args = { siteId: created.site.id, expectedRevision: 0, releaseId, outputPath: "/build", manifest };
      const published = await handleSitePublish(args, ctx);
      expect(published.publication).toMatchObject({ revision: 1, releaseId });
      expect(published.manifest).toEqual(manifest);
      expect(published.shareUrl).toBe("https://alice.spaces.example/public/demo");
      expect(await (await ctx.env.STORAGE.get(`${siteReleasePrefix(created.site.id, releaseId)}files/index.html`))!.text()).toBe("<h1>first</h1>");
      expect((await readSitePublication(ctx.env.STORAGE, "demo"))!.record.manifest!.source).toEqual(manifest.source);
      await expect(handleSitePublish({ ...args, expectedRevision: 1, manifest: { ...manifest, title: "changed" } }, ctx)).rejects.toThrow("already bound");
      const sourceFetch = ctx.env.RIPGIT.fetch.bind(ctx.env.RIPGIT);
      vi.spyOn(ctx.env.RIPGIT, "fetch").mockImplementationOnce(async (...input) => {
        await handleSiteUnpublish({ siteId: created.site.id, expectedRevision: 1 }, ctx);
        return sourceFetch(...input);
      });
      await expect(handleSitePublish({ ...args, releaseId: crypto.randomUUID(), expectedRevision: 1 }, ctx)).rejects.toThrow("Publication changed");
      expect(await handleSiteGet({ siteId: created.site.id }, ctx)).toMatchObject({
        publication: { revision: 2, releaseId: null }, manifest,
      });
      const response = await servePublishedSite(new Request(`${created.site.origin}/_r/${releaseId}/index.html`), ctx.env.STORAGE, { siteId: created.site.id, slug: "demo" });
      expect(response.status).toBe(404);
      await response.body?.cancel();
    });
  });

  it("rejects bad checksums, missing source revisions, unsafe paths and source access outside the owner", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = context(sql);
      const { site } = await handleSiteCreate({ slug: "broken" }, ctx);
      const manifest = await output(ctx, "<h1>safe</h1>");
      const args = { siteId: site.id, expectedRevision: 0, releaseId: crypto.randomUUID(), outputPath: "/build", manifest };
      await expect(handleSitePublish({ ...args, manifest: { ...manifest, files: [{ ...manifest.files[0], sha256: "0".repeat(64) }] } }, ctx)).rejects.toThrow();
      expect(await readSitePublication(ctx.env.STORAGE, site.slug)).toBeNull();
      await expect(handleSitePublish({ ...args, manifest: { ...manifest, files: [{ ...manifest.files[0], path: "../secret" }] } }, ctx)).rejects.toThrow();
      await expect(handleSitePublish({ ...args, manifest: { ...manifest, entry: "docs/index.html", files: [{ ...manifest.files[0], path: "docs/index.html" }] } }, ctx)).rejects.toThrow("build root");
      await expect(handleSitePublish({ ...args, manifest: { ...manifest, source: { repo: "bob/private", revision: SOURCE_REVISION } } }, ctx)).rejects.toThrow("cannot read repo");
      await expect(handleSitePublish({ ...args, manifest: { ...manifest, source: { repo: "alice/demo", revision: "b".repeat(40) } } }, ctx)).rejects.toThrow("Source revision");
      const fs = new GsvFs(ctx.env.STORAGE, OWNER);
      await expect(fs.writeFile("/__sites/publications/broken.json", "{}" )).rejects.toThrow("site.*");
      await fs.writeFile("/secret.html", "private");
      await fs.symlink("/secret.html", "/build/outside.html");
      const escaped = { ...manifest, entry: "outside.html", files: [{ ...manifest.files[0], path: "outside.html", size: 7 }] };
      await expect(handleSitePublish({ ...args, releaseId: crypto.randomUUID(), manifest: escaped }, ctx)).rejects.toThrow("symlink leaves");
    });
  });

  it("does not publish after cancellation and preserves existing public files", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = context(sql);
      await ctx.env.STORAGE.put("public/existing", "legacy");
      await expect(handleSiteCreate({ slug: "existing" }, ctx)).rejects.toThrow("existing public file");
      const { site } = await handleSiteCreate({ slug: "cancelled" }, ctx);
      const manifest = await output(ctx, "<h1>cancelled</h1>");
      const controller = new AbortController();
      controller.abort();
      await expect(handleSitePublish({ siteId: site.id, expectedRevision: 0, releaseId: crypto.randomUUID(), outputPath: "/build", manifest }, { ...ctx, requestSignal: controller.signal })).rejects.toThrow();
      expect(await readSitePublication(ctx.env.STORAGE, site.slug)).toBeNull();
    });
  });

  it("cancels the source body when storage refuses an upload before reading it", async () => {
    await runWithRealKernelSql(async (sql) => {
      const ctx = context(sql);
      const { site } = await handleSiteCreate({ slug: "storage-failure" }, ctx);
      const manifest = await output(ctx, "<h1>pending</h1>");
      let cancelled = false;
      const openFile = R2MountBackend.prototype.openFile;
      const opened = vi.spyOn(R2MountBackend.prototype, "openFile").mockImplementationOnce(async function (path, options) {
        const file = await openFile.call(this, path, options);
        await file.body?.cancel();
        return { ...file, body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) };
      });
      const put = ctx.env.STORAGE.put.bind(ctx.env.STORAGE);
      const upload = vi.spyOn(ctx.env.STORAGE, "put").mockImplementationOnce(put).mockRejectedValueOnce(new Error("Storage unavailable"));
      try {
        await expect(handleSitePublish({ siteId: site.id, expectedRevision: 0, releaseId: crypto.randomUUID(), outputPath: "/build", manifest }, ctx))
          .rejects.toThrow("Storage unavailable");
        expect(cancelled).toBe(true);
        expect(await readSitePublication(ctx.env.STORAGE, site.slug)).toBeNull();
      } finally {
        opened.mockRestore();
        upload.mockRestore();
      }
    });
  });
});

async function output(ctx: KernelContext, html: string): Promise<SiteManifest> {
  const fs = new GsvFs(ctx.env.STORAGE, OWNER);
  await fs.mkdir("/build", { recursive: true });
  await fs.writeFile("/build/index.html", html);
  const bytes = new TextEncoder().encode(html);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { version: 1, entry: "index.html", routing: "static", title: "Demo", description: "A demo", source: { repo: "alice/demo", revision: SOURCE_REVISION },
    files: [{ path: "index.html", size: bytes.length, sha256 }] };
}

function context(sql: SqlStorage): KernelContext {
  const installationId = `inst_${crypto.randomUUID()}`;
  const ctx = {
    installationId, installationIdentity: { installationId, handle: "alice", canonicalOrigin: "https://alice.spaces.example" },
    sites: new SiteStore(sql), peer: testPeer({ kind: "human", account: OWNER, calls: ["site.*", "fs.read", "repo.log"] }),
    config: { list: () => [], get: () => null },
    auth: { getPasswdByUid: () => OWNER, getPasswdByUsername: () => null, isPersonalAgentUid: () => false },
    env: {
      STORAGE: createInstallationStorage(env.STORAGE, installationId),
      PUBLICATION_DIRECTORY: { registerPublication: async ({ siteId }: { siteId: string }) => ({ origin: `https://${siteId}.usercontent.example` }) },
      RIPGIT: { fetch: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        return Response.json(url.pathname.includes(SOURCE_REVISION) || url.search.includes(SOURCE_REVISION)
          ? [{ hash: SOURCE_REVISION, tree_hash: "tree", author: "alice", author_email: "alice@example.com", author_time: 1,
            committer: "alice", committer_email: "alice@example.com", commit_time: 1, message: "source", parents: [] }] : []);
      } },
    },
  };
  // SAFETY: These handlers use the real SQL/R2 stores and the explicit repository and account fixtures above.
  return ctx as KernelContext;
}
