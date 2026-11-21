import { profileContactPolicy } from "@humansandmachines/gsv/protocol";
import { toBase64Url } from "@atcute/multibase";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { ProfileAvatarFile } from "./kernel/profile-store";
import type { PublicProfileProjection } from "./kernel/profiles";
import { SERVER_RELEASE } from "./version";
import { renderPublicProfile } from "../../../web/src/public/profile";

/** The page, its picture, its link preview card, an alias link from before a Ship had one profile, or a malformed alias. */
export type PublicProfilePath = "page" | "avatar" | "card" | "alias" | "invalid";

/** The Kernel's answers for the public profile. */
export type PublicProfileSource = {
  page(): Promise<PublicProfileProjection | null>;
  avatar(): Promise<ProfileAvatarFile | null>;
};

const ALIAS_PATH = /^\/@[a-z][a-z0-9_-]{1,31}$/;
const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function matchPublicProfilePath(path: string): PublicProfilePath | null {
  if (path === "/profile") return "page";
  if (path === "/profile/avatar") return "avatar";
  if (path === "/profile/card") return "card";
  if (path.startsWith("/@")) return ALIAS_PATH.test(path) ? "alias" : "invalid";
  return null;
}

export async function servePublicProfileRequest(
  request: Request,
  path: PublicProfilePath,
  source: PublicProfileSource,
  homeOrigin?: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
  if (path === "invalid") return unavailable();
  // A Ship has one profile, so a link to one of its old aliases opens it.
  if (path === "alias") return new Response(null, { status: 308, headers: { location: "/", "cache-control": "no-store" } });
  let projection: PublicProfileProjection | null;
  try {
    if (path === "avatar") return serveAvatar(request, await source.avatar());
    projection = await source.page();
  } catch (error) {
    // The Kernel fails closed while it can't say what the Ship's host has taken down.
    console.error("[Gateway] Public profile lookup failed:", exceptionDiagnostics(error));
    return new Response("Profile unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!projection) return unavailable();
  if (path === "card") return await serveCard(request, projection, source);
  if (new URL(request.url).origin !== new URL(projection.url).origin) {
    return new Response(null, { status: 308, headers: { location: projection.url, "cache-control": "no-store" } });
  }
  return await pageResponse(request, projection, homeOrigin);
}

/**
 * The Ship's own address, `/`: its public profile while it has one there, or
 * null, and the app opens instead. A Ship without a profile, one reached on
 * another of its hosts, and one whose profile lookup fails all keep the app,
 * so its owner is never locked out of it.
 */
export async function servePublicProfileHome(
  request: Request,
  source: Pick<PublicProfileSource, "page">,
  homeOrigin?: string,
): Promise<Response | null> {
  let projection: PublicProfileProjection | null;
  try {
    projection = await source.page();
  } catch (error) {
    console.error("[Gateway] Public profile lookup failed:", exceptionDiagnostics(error));
    return null;
  }
  if (!projection || new URL(request.url).origin !== new URL(projection.url).origin) return null;
  return await pageResponse(request, projection, homeOrigin);
}

async function pageResponse(request: Request, projection: PublicProfileProjection, homeOrigin: string | undefined): Promise<Response> {
  const { record } = projection;
  const body = renderPublicProfile({
    url: projection.url, ...(projection.handle ? { handle: projection.handle } : undefined),
    displayName: record.displayName, about: record.about ?? "",
    contactPolicy: profileContactPolicy(record.contactPolicy), avatar: projection.avatar?.cid ?? null,
    card: await cardVersion(projection),
  }, homeOrigin);
  const etag = `"${await digest(body)}"`;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate", etag,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": PAGE_POLICY,
    "x-robots-tag": "noindex, nofollow",
  });
  if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

/** The picture the published record names, as the Ship keeps it; a sandboxed image and nothing else. */
function serveAvatar(request: Request, avatar: ProfileAvatarFile | null): Response {
  if (!avatar) return unavailable();
  const etag = `"${avatar.cid}"`;
  const headers = new Headers({
    "content-type": avatar.mimeType, "content-length": String(avatar.size),
    "cache-control": "public, max-age=0, must-revalidate", etag,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-robots-tag": "noindex, nofollow",
  });
  if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : avatar.bytes, { headers });
}

/** The card the published profile draws, in this release's design; a sandboxed image and nothing else. */
async function serveCard(request: Request, projection: PublicProfileProjection, source: PublicProfileSource): Promise<Response> {
  const { record } = projection;
  const etag = `"${await cardVersion(projection)}"`;
  const headers = new Headers({
    "content-type": "image/png", "cache-control": "public, max-age=0, must-revalidate", etag,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-robots-tag": "noindex, nofollow",
  });
  if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  let png: Uint8Array;
  try {
    // The card's renderer loads with the first card an isolate draws, not with every Gateway start.
    const { renderProfileCard } = await import("./profile-card/card");
    png = await renderProfileCard({
      host: new URL(projection.url).host, ...(projection.handle ? { handle: projection.handle } : undefined),
      displayName: record.displayName, about: record.about ?? "",
      requests: profileContactPolicy(record.contactPolicy) === "requests",
      picture: projection.avatar ? await source.avatar() : null,
    });
  } catch (error) {
    console.error("[Gateway] Profile card failed:", exceptionDiagnostics(error));
    return new Response("Card unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  headers.set("content-length", String(png.byteLength));
  return new Response(png, { headers });
}

/**
 * The version of the card the published profile draws: this release's design and everything of the
 * profile it shows, including whether the host has taken its picture down. The page's link to the card
 * names it, so apps fetch a changed card, and it is the card's ETag.
 */
async function cardVersion(projection: PublicProfileProjection): Promise<string> {
  return await digest([SERVER_RELEASE, projection.url, projection.handle ?? "", projection.cid, projection.avatar?.cid ?? ""].join("\n"));
}

async function digest(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

function matchesEtag(request: Request, etag: string): boolean {
  return request.headers.get("if-none-match")?.split(",").map((entry) => entry.trim()).includes(etag) ?? false;
}

function unavailable(): Response {
  return new Response("Profile unavailable", { status: 404, headers: { "cache-control": "no-store" } });
}
