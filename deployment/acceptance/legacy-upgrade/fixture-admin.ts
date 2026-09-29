import { timingSafeEqual } from "node:crypto";

export type FixtureAdminEnvironment = { FIXTURE_ADMIN_SECRET: string; FIXTURE_ADMIN_ORIGIN: string };

/**
 * Acceptance-only admission for historical Accounts' localhost admin boundary.
 * It does not represent Cloudflare Access or public owner-authentication coverage.
 * The inherited Accounts implementation still owns every directory/reset operation.
 */
export async function fixtureAdminRequest(request: Request, environment: FixtureAdminEnvironment): Promise<Request | Response> {
  const url = new URL(request.url);
  const supplied = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
  const expected = environment.FIXTURE_ADMIN_SECRET;
  const authenticated = /^[a-f0-9]{64}$/.test(expected) && supplied.length === expected.length
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  const allowedPath = /^\/admin\/api\/installations(?:\/[^/]+(?:\/(?:reset|onboarding))?)?$/.test(url.pathname);
  const allowed = authenticated && url.origin === environment.FIXTURE_ADMIN_ORIGIN && allowedPath
    && (request.method === "GET" || request.method === "POST")
    && (request.method === "GET" || request.headers.get("origin") === environment.FIXTURE_ADMIN_ORIGIN);
  if (!allowed) {
    await request.body?.cancel();
    return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const forwarded = new Request(`http://localhost${url.pathname}${url.search}`, request);
  const headers = forwarded.headers;
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("cf-access-jwt-assertion");
  if (request.method === "POST") headers.set("origin", "http://localhost");
  return forwarded;
}
