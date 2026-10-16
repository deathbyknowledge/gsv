import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { SiteManifest } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/services/directory";
import gateway from "../index";
import { createInstallationStorage } from "../installation/storage";
import { inferContentType } from "../fs/utils";
import { servePublishedSite, serveSiteShare } from "./http";
import { siteReleasePrefix, writeSitePublication, type SitePublishedRecord } from "./storage";

const SITE = { id: `site-${"a".repeat(32)}`, slug: "demo", origin: `https://site-${"a".repeat(32)}.usercontent.example`, createdAtMs: 1 };
const IDENTITY = { installationId: "inst_fixture", handle: "alice", canonicalOrigin: "https://alice.spaces.example" };

describe("published site serving", () => {
  it("serves scripts/WASM, real 404s, navigation-only SPA fallback, ranges, validators and HEAD", async () => {
    const { bucket, releaseId, record } = await fixture("spa");
    const request = (path: string, init?: RequestInit) => servePublishedSite(new Request(`${SITE.origin}/_r/${releaseId}/${path}`, init), bucket, { siteId: SITE.id, slug: SITE.slug }, IDENTITY);
    const html = await request("");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).not.toContain("sandbox");
    expect(await html.text()).toContain("app.js");
    const wasm = await request("game.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("cache-control")).toContain("immutable");
    expect(new TextDecoder().decode(await wasm.arrayBuffer())).toBe("wasmbytes");
    const range = await request("game.wasm", { headers: { range: "bytes=1-3" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-3/9");
    expect(new TextDecoder().decode(await range.arrayBuffer())).toBe("asm");
    const conditional = await request("game.wasm", { headers: { "if-none-match": wasm.headers.get("etag")! } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    const head = await request("game.wasm", { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("9");
    expect(await head.text()).toBe("");
    for (const [path, headers] of [["missing.js", { accept: "text/html" }], ["api/data", { accept: "application/json" }], ["%2e%2e/manifest.json", {}]] as const) {
      const missing = await request(path, { headers });
      expect(missing.status).toBe(404);
      await missing.body?.cancel();
    }
    const navigation = await request("boards/today", { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } });
    expect(navigation.status).toBe(200);
    await navigation.body?.cancel();
    const staticRecord = { ...record, manifest: { ...record.manifest!, routing: "static" as const } };
    await bucket.delete("__sites/publications/demo.json");
    await writeSitePublication(bucket, staticRecord);
    const staticMiss = await request("boards/today", { headers: { accept: "text/html" } });
    expect(staticMiss.status).toBe(404);
    await staticMiss.body?.cancel();
  });

  it("pins old tabs to their release and blocks old assets after unpublish", async () => {
    const { bucket, releaseId, record } = await fixture("static");
    const nextId = crypto.randomUUID();
    await bucket.put(`${siteReleasePrefix(SITE.id, releaseId)}manifest.json`, JSON.stringify({ siteId: SITE.id, releaseId, manifest: record.manifest }));
    const next = { ...record, publication: { revision: 2, releaseId: nextId, publishedAtMs: 2 }, releases: [releaseId, nextId] };
    const current = (await bucket.head("__sites/publications/demo.json"))!;
    await writeSitePublication(bucket, next, current.etag);
    const old = await servePublishedSite(new Request(`${SITE.origin}/_r/${releaseId}/app.js`), bucket, { siteId: SITE.id, slug: SITE.slug }, IDENTITY);
    expect(await old.text()).toBe("window.demo = true;");
    const root = await servePublishedSite(new Request(`${SITE.origin}/?level=2`), bucket, { siteId: SITE.id, slug: SITE.slug }, IDENTITY);
    expect(root.headers.get("location")).toBe(`/_r/${nextId}/?level=2`);
    const etag = (await bucket.head("__sites/publications/demo.json"))!.etag;
    await writeSitePublication(bucket, { ...next, manifest: null, publication: { revision: 3, releaseId: null, publishedAtMs: null } }, etag);
    const hidden = await servePublishedSite(new Request(`${SITE.origin}/_r/${releaseId}/app.js`), bucket, { siteId: SITE.id, slug: SITE.slug }, IDENTITY);
    expect(hidden.status).toBe(404);
    await hidden.body?.cancel();
    const unpublishedShare = await serveSiteShare(new Request(`${IDENTITY.canonicalOrigin}/public/demo`), bucket, "demo", IDENTITY);
    expect(unpublishedShare!.status).toBe(404);
    await unpublishedShare!.body?.cancel();
  });

  it("renders escaped social metadata and isolates the app from the trusted share origin", async () => {
    const { bucket } = await fixture("static");
    const response = await serveSiteShare(new Request(`${IDENTITY.canonicalOrigin}/public/demo`), bucket, "demo", IDENTITY);
    const html = await response!.text();
    expect(html).toContain('property="og:title" content="&lt;Demo&gt;"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain(`property="og:url" content="${IDENTITY.canonicalOrigin}/public/demo"`);
    expect(html).toContain(`src="${SITE.origin}/_r/`);
    expect(html).toContain("allow-scripts allow-same-origin");
    expect(html).not.toContain("alice/private-source");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(response!.headers.get("content-security-policy")).toContain(`frame-src ${SITE.origin}`);
  });

  it("admits exact registered hosts without touching Kernel and rejects every inactive lifecycle state", async () => {
    const { bucket, releaseId } = await fixture("static", IDENTITY.installationId);
    let state: Extract<InstallationDirectoryResult, { found: true }>["state"] = "active";
    const resolveHostname = vi.fn(async (hostname: string): Promise<InstallationDirectoryResult> => hostname === new URL(SITE.origin).hostname
      ? { found: true, ...IDENTITY, state, publication: { siteId: SITE.id, slug: SITE.slug } } : { found: false });
    const previous = Object.getOwnPropertyDescriptor(env, "INSTALLATION_DIRECTORY");
    Object.defineProperty(env, "INSTALLATION_DIRECTORY", { configurable: true, value: { resolveHostname } });
    const kernel = vi.spyOn(env.KERNEL, "getByName");
    try {
      const ok = await gateway.fetch(new Request(`${SITE.origin}/_r/${releaseId}/app.js`), env);
      expect(await ok.text()).toBe("window.demo = true;");
      const bootstrap = await gateway.fetch(new Request(`${SITE.origin}/_gsv/site.json`), env);
      expect(await bootstrap.json()).toEqual({ version: 1, installationId: IDENTITY.installationId,
        siteId: SITE.id, siteOrigin: SITE.origin, gatewayOrigin: IDENTITY.canonicalOrigin });
      expect(bootstrap.headers.get("cache-control")).toBe("no-store");
      expect(bootstrap.headers.get("access-control-allow-origin")).toBeNull();
      for (const path of ["/ws", "/public/demo", "/.well-known/gsv/deployment.json"]) {
        const response = await gateway.fetch(new Request(`${SITE.origin}${path}`, path === "/ws" ? { headers: { upgrade: "websocket" } } : undefined), env);
        expect(response.status).toBe(404);
        await response.body?.cancel();
      }
      for (const inactive of ["provisioning", "restricted", "retained", "deleted"] as const) {
        state = inactive;
        const response = await gateway.fetch(new Request(`${SITE.origin}/_r/${releaseId}/app.js`), env);
        expect(response.status).toBe(404);
        await response.body?.cancel();
        const metadata = await gateway.fetch(new Request(`${SITE.origin}/_gsv/site.json`), env);
        expect(metadata.status).toBe(404);
        await metadata.body?.cancel();
      }
      const unknown = await gateway.fetch(new Request("https://random.usercontent.example/"), env);
      expect(unknown.status).toBe(404);
      await unknown.body?.cancel();
      expect(kernel).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(env, "INSTALLATION_DIRECTORY", previous);
      else Reflect.deleteProperty(env, "INSTALLATION_DIRECTORY");
      kernel.mockRestore();
      await bucket.delete("__sites/publications/demo.json");
    }
  });
});

async function fixture(routing: "static" | "spa", installationId = `inst_${crypto.randomUUID()}`) {
  const bucket = createInstallationStorage(env.STORAGE, installationId);
  const releaseId = crypto.randomUUID();
  const contents = { "index.html": '<script src="./app.js"></script>', "app.js": "window.demo = true;", "game.wasm": "wasmbytes" };
  const files = Object.entries(contents).map(([path, body]) => ({ path, size: body.length, sha256: "0".repeat(64) }));
  for (const [path, body] of Object.entries(contents)) {
    await bucket.put(`${siteReleasePrefix(SITE.id, releaseId)}files/${path}`, body, { httpMetadata: { contentType: inferContentType(path) } });
  }
  const manifest: SiteManifest = { version: 1, entry: "index.html", routing, title: "<Demo>", description: 'A "demo"',
    source: { repo: "alice/private-source", revision: "a".repeat(40) }, files };
  const record: SitePublishedRecord = { site: SITE, publication: { revision: 1, releaseId, publishedAtMs: 1 }, manifest, releases: [releaseId] };
  await writeSitePublication(bucket, record);
  return { bucket, releaseId, record };
}
