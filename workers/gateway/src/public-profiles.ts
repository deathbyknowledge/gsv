import { profileContactPolicy } from "@humansandmachines/gsv/protocol";
import { toBase64Url } from "@atcute/multibase";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { ProfileAvatarFile } from "./kernel/profile-store";
import type { PublicProfileProjection } from "./kernel/profiles";
import { renderPublicProfile } from "../../../web/src/public/profile";

/** The page, its picture, an alias link from before a Ship had one profile, or a malformed alias. */
export type PublicProfilePath = "page" | "avatar" | "alias" | "invalid";

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
  if (path === "alias") return new Response(null, { status: 308, headers: { location: "/profile", "cache-control": "no-store" } });
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
  if (new URL(request.url).origin !== new URL(projection.url).origin) {
    return new Response(null, { status: 308, headers: { location: projection.url, "cache-control": "no-store" } });
  }
  const { record } = projection;
  const body = renderPublicProfile({
    url: projection.url, ...(projection.handle ? { handle: projection.handle } : undefined),
    displayName: record.displayName, about: record.about ?? "",
    contactPolicy: profileContactPolicy(record.contactPolicy), avatar: projection.avatar !== undefined,
  }, homeOrigin);
  const etag = `"${toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))))}"`;
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

function matchesEtag(request: Request, etag: string): boolean {
  return request.headers.get("if-none-match")?.split(",").map((entry) => entry.trim()).includes(etag) ?? false;
}

function unavailable(): Response {
  return new Response("Profile unavailable", { status: 404, headers: { "cache-control": "no-store" } });
}
