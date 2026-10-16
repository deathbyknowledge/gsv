import { siteFilePathSchema, siteReleaseIdSchema, siteSlugSchema, type SiteBootstrap } from "@humansandmachines/gsv/protocol";
import type { InstallationIdentity } from "@humansandmachines/gsv/services/directory";
import { renderPublicSite } from "../../../../web/src/public/site";
import { R2MountBackend } from "../fs/backends/r2";
import { openFileOptionsFromRequest } from "../public-assets";
import { readSitePublication, readSiteRelease, siteFileUrlPath, siteReleaseBase, siteReleasePrefix } from "./storage";

export function matchSiteSharePath(pathname: string): string | null {
  const match = /^\/public\/([^/]+)\/?$/.exec(pathname);
  return match && siteSlugSchema.safeParse(match[1]).success ? match[1] : null;
}

export async function serveSiteShare(request: Request, bucket: R2Bucket, slug: string, identity: InstallationIdentity): Promise<Response | null> {
  const current = await readSitePublication(bucket, slug);
  if (!current) return null;
  if (!current.record.publication.releaseId || !current.record.manifest) return unavailable();
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
  const { site, publication, manifest } = current.record;
  const launchUrl = new URL(siteReleaseBase(publication.releaseId!), site.origin).href;
  const shareUrl = new URL(`/public/${slug}`, identity.canonicalOrigin).href;
  const imageUrl = manifest.image
    ? new URL(`${siteReleaseBase(publication.releaseId!)}${siteFileUrlPath(manifest.image)}`, site.origin).href
    : new URL("/brand/gsv-ship.png", identity.canonicalOrigin).href;
  const body = renderPublicSite({ manifest, launchUrl, shareUrl, imageUrl });
  return new Response(request.method === "HEAD" ? null : body, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-src ${site.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  } });
}

export async function servePublishedSite(request: Request, bucket: R2Bucket, route: { siteId: string; slug: string }, identity: InstallationIdentity): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
  if (request.headers.get("upgrade")) return unavailable();
  const current = await readSitePublication(bucket, route.slug);
  if (!current?.record.publication.releaseId || current.record.site.id !== route.siteId) return unavailable();
  const { site, publication } = current.record;
  const url = new URL(request.url);
  if (url.origin !== site.origin) return unavailable();
  if (url.pathname === "/_gsv/site.json") {
    const bootstrap: SiteBootstrap = { version: 1, installationId: identity.installationId, siteId: site.id, siteOrigin: site.origin, gatewayOrigin: identity.canonicalOrigin };
    return new Response(request.method === "HEAD" ? null : JSON.stringify(bootstrap), { headers: {
      "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    } });
  }
  if (url.pathname === "/") {
    return new Response(null, { status: 302, headers: { location: siteReleaseBase(publication.releaseId!) + url.search, "cache-control": "no-store" } });
  }
  const match = /^\/_r\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!match || !siteReleaseIdSchema.safeParse(match[1]).success || !current.record.releases.includes(match[1])) return unavailable();
  const releaseId = match[1];
  let path: string;
  try { path = match[2].split("/").map(decodeURIComponent).join("/"); } catch { return unavailable(); }
  if (path && !siteFilePathSchema.safeParse(path.replace(/\/$/, "")).success) return unavailable();
  const release = releaseId === publication.releaseId
    ? { siteId: site.id, releaseId, manifest: current.record.manifest! }
    : await readSiteRelease(bucket, site.id, releaseId);
  if (!release || release.siteId !== site.id) return unavailable();
  const manifest = release.manifest;
  let file = manifest.files.find((entry) => entry.path === (path || manifest.entry));
  if (!file && path && !path.endsWith("/") && manifest.files.some((entry) => entry.path === `${path}/index.html`)) {
    return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}`, "cache-control": "no-store" } });
  }
  if (!file && path.endsWith("/")) file = manifest.files.find((entry) => entry.path === `${path}index.html`);
  const navigation = request.headers.get("sec-fetch-mode") === "navigate"
    || (request.headers.get("accept") ?? "").split(",").some((part) => part.trim().split(";")[0] === "text/html");
  if (!file && manifest.routing === "spa" && navigation && !path.split("/").at(-1)?.includes(".")) {
    file = manifest.files.find((entry) => entry.path === manifest.entry);
  }
  if (!file) return unavailable();
  const options = openFileOptionsFromRequest(request);
  if (!options || (options.range && (file.size === 0 || ("offset" in options.range && options.range.offset >= file.size)))) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.size}`, "cache-control": "no-store" } });
  }
  const backend = new R2MountBackend(bucket, { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" });
  const key = `${siteReleasePrefix(site.id, releaseId)}files/${file.path}`;
  let opened = await backend.openFile(`/${key}`, options);
  const ifRange = request.headers.get("if-range");
  if (ifRange && opened.range && ifRange !== opened.etag
    && (!Number.isFinite(Date.parse(ifRange)) || Date.parse(ifRange) < Math.floor(opened.mtime.getTime() / 1000) * 1000)) {
    await opened.body?.cancel();
    opened = await backend.openFile(`/${key}`, { conditions: options.conditions });
  }
  const headers = new Headers({
    "content-type": opened.contentType ?? "application/octet-stream", "etag": opened.etag!,
    "last-modified": opened.mtime.toUTCString(), "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "accept-ranges": "bytes",
    "content-security-policy": "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'",
  });
  if (opened.status !== 304 && opened.status !== 412) headers.set("content-length", String(opened.size));
  if (opened.range) headers.set("content-range", `bytes ${opened.range.offset}-${opened.range.offset + opened.range.length - 1}/${file.size}`);
  if (request.method === "HEAD") await opened.body?.cancel();
  return new Response(request.method === "HEAD" ? null : opened.body ?? null, { status: opened.status, headers });
}

function unavailable(): Response { return new Response("Site unavailable", { status: 404, headers: { "cache-control": "no-store" } }); }
function methodNotAllowed(): Response { return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } }); }
