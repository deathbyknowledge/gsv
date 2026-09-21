import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { PublicProfile } from "@humansandmachines/gsv/protocol";
import { createInstallationStorage } from "./installation/storage";
import { matchPublicProfilePath, servePublicProfileRequest } from "./public-profiles";

const PROFILE: PublicProfile = {
  version: 2, domain: "gsv-federation/2/profile", actor: { shipId: "ship:one", subjectId: "subject:one" },
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, origin: "https://profile.example", url: "https://profile.example/@person",
  alias: "person", displayName: "Person <script>alert(1)</script>", about: "<img src=x onerror=alert(1)>\nHello", contactPolicy: "invitation", representation: "human",
  revision: 1, publishedAtMs: 1, signature: "fixture",
};
const projection = { ownerUid: 1000, alias: "person", revision: 1, key: "social/profiles/subject/1.json" };

describe("public profile projection serving", () => {
  it("hands off only the reviewed public profile address without creating an approach", async () => {
    const bucket = createInstallationStorage(env.STORAGE, `inst_${crypto.randomUUID()}`);
    await bucket.put(projection.key, JSON.stringify({ ...PROFILE, contactPolicy: "requests" }));
    const response = await servePublicProfileRequest(new Request(PROFILE.url), { locator: { alias: "person" }, json: false }, bucket, async () => projection);
    const html = await response.text();
    expect(html).toContain('data-profile="https://profile.example/@person"');
    expect(html).toContain('src="/social/connect.js"');
    expect(html).toContain("Your GSV address");
    expect(html).not.toContain("approach.create");
    expect(html).not.toContain("ownerUid");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("uses exact alias and subject routes without admitting ambiguous paths", () => {
    expect(matchPublicProfilePath("/@person")).toEqual({ locator: { alias: "person" }, json: false });
    expect(matchPublicProfilePath("/_gsv/federation/v2/subjects/subject%3Aone")).toEqual({ locator: { subjectId: "subject:one" }, json: true });
    for (const path of ["/@", "/@person/extra", "/@%70erson", "/@PERSON", "/_gsv/federation/v2/subjects/%2f", "/_gsv/federation/v2/subjects/%"]) {
      expect(matchPublicProfilePath(path)).toEqual({ invalid: true });
    }
    expect(matchPublicProfilePath("/zen")).toBeNull();
  });

  it("escapes published text, serves signed JSON separately, and rechecks before a 304", async () => {
    const bucket = createInstallationStorage(env.STORAGE, `inst_${crypto.randomUUID()}`);
    await bucket.put(projection.key, JSON.stringify(PROFILE));
    const resolve = vi.fn(async () => projection);
    const path = { locator: { alias: "person" }, json: false };
    const page = await servePublicProfileRequest(new Request(PROFILE.url), path, bucket, resolve);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("ownerUid");
    const json = await servePublicProfileRequest(new Request(PROFILE.url, { headers: { accept: "application/json" } }), path, bucket, resolve);
    expect(await json.json()).toEqual(PROFILE);
    expect(json.headers.get("etag")).not.toBe(page.headers.get("etag"));
    const cached = await servePublicProfileRequest(new Request(PROFILE.url, { headers: { "if-none-match": page.headers.get("etag")! } }), path, bucket, resolve);
    expect(cached.status).toBe(304);
    const revoked = await servePublicProfileRequest(new Request(PROFILE.url, { headers: { "if-none-match": page.headers.get("etag")! } }), path, bucket, async () => null);
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get("cache-control")).toBe("no-store");
    expect(resolve).toHaveBeenCalledTimes(6);
  });

  it("does not expose a projection withdrawn while its bytes were being read", async () => {
    const bucket = createInstallationStorage(env.STORAGE, `inst_${crypto.randomUUID()}`);
    await bucket.put(projection.key, JSON.stringify(PROFILE));
    let calls = 0;
    const response = await servePublicProfileRequest(new Request(PROFILE.url), { locator: { alias: "person" }, json: false }, bucket, async () => ++calls === 1 ? projection : null);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Profile unavailable");
  });
});
