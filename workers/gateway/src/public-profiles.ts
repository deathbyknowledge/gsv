import { publicProfileAliasSchema, publicProfileSchema } from "@humansandmachines/gsv/protocol";
import type { PublicProfileLocator, PublicProfileProjection } from "./kernel/profile-store";
import { sha256Base64Url } from "./kernel/federation-crypto";
import { renderPublicProfile } from "../../../web/src/public/profile";

const SUBJECT_PATH = "/_gsv/federation/v2/subjects/";
export type PublicProfilePath = { locator: PublicProfileLocator; json: boolean } | { invalid: true };

export function matchPublicProfilePath(path: string): PublicProfilePath | null {
  if (path.startsWith("/@")) {
    const alias = publicProfileAliasSchema.safeParse(path.slice(2));
    return alias.success ? { locator: { alias: alias.data }, json: false } : { invalid: true };
  }
  if (path.startsWith(SUBJECT_PATH)) {
    const encoded = path.slice(SUBJECT_PATH.length);
    try {
      const subjectId = decodeURIComponent(encoded);
      if (!subjectId || subjectId.length > 256 || subjectId.includes("/") || encodeURIComponent(subjectId) !== encoded) return { invalid: true };
      return { locator: { subjectId }, json: true };
    } catch { return { invalid: true }; }
  }
  return null;
}

export async function servePublicProfileRequest(
  request: Request,
  path: PublicProfilePath,
  storage: R2Bucket,
  resolve: (locator: PublicProfileLocator) => Promise<PublicProfileProjection | null>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
  if ("invalid" in path) return unavailable();
  const projection = await resolve(path.locator);
  if (!projection) return unavailable();
  const object = await storage.get(projection.key);
  if (!object) return unavailable();
  if (object.size > 16_384) {
    await object.body.cancel();
    return unavailable();
  }
  const source = await object.text();
  const profile = publicProfileSchema.parse(JSON.parse(source));
  const json = path.json || (request.headers.get("accept") ?? "").split(",").some((entry) => entry.trim().split(";")[0] === "application/json");
  const body = json ? source : renderPublicProfile(profile);
  const etag = `"${await sha256Base64Url(body)}"`;
  const current = await resolve(path.locator);
  if (!current || current.key !== projection.key || current.revision !== profile.revision || current.alias !== profile.alias) return unavailable();
  const headers = new Headers({
    "content-type": json ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate", vary: "Accept", etag,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "x-robots-tag": "noindex, nofollow",
  });
  if (request.headers.get("if-none-match")?.split(",").map((entry) => entry.trim()).includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

function unavailable(): Response {
  return new Response("Profile unavailable", { status: 404, headers: { "cache-control": "no-store" } });
}
