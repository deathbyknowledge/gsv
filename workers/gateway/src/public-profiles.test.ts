import { describe, expect, it, vi } from "vitest";
import type { PublicProfile } from "@humansandmachines/gsv/protocol";
import { matchPublicProfilePath, servePublicProfileRequest } from "./public-profiles";

const PROFILE: PublicProfile = {
  version: 2, domain: "gsv-federation/2/profile", actor: { shipId: "ship:one", subjectId: "subject:one" },
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, origin: "https://profile.example", url: "https://profile.example/@person",
  alias: "person", displayName: "Person <script>alert(1)</script>", about: "<img src=x onerror=alert(1)>\nHello", contactPolicy: "invitation", representation: "human",
  revision: 1, publishedAtMs: 1, signature: "fixture",
};
const projection = { ownerUid: 1000, alias: "person", revision: 1, profile: PROFILE };

describe("public profile projection serving", () => {
  it("hands off only the reviewed public profile address without creating an approach", async () => {
    const response = await servePublicProfileRequest(new Request(PROFILE.url), { locator: { alias: "person" }, json: false }, async () => ({ ...projection, profile: { ...PROFILE, contactPolicy: "requests" } }));
    const html = await response.text();
    expect(html).toContain('data-profile="https://profile.example/@person"');
    expect(html).toContain('src="/social/connect.js"');
    expect(html).toContain("Your GSV address");
    expect(html).not.toContain("approach.create");
    expect(html).not.toContain("ownerUid");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("uses exact alias and subject routes without admitting ambiguous paths", () => {
    expect(matchPublicProfilePath("/profile")).toEqual({ locator: { space: true }, json: false });
    expect(matchPublicProfilePath("/@person")).toEqual({ locator: { alias: "person" }, json: false });
    expect(matchPublicProfilePath("/_gsv/federation/v2/subjects/subject%3Aone")).toEqual({ locator: { subjectId: "subject:one" }, json: true });
    for (const path of ["/@", "/@person/extra", "/@%70erson", "/@PERSON", "/_gsv/federation/v2/subjects/%2f", "/_gsv/federation/v2/subjects/%"]) {
      expect(matchPublicProfilePath(path)).toEqual({ invalid: true });
    }
    expect(matchPublicProfilePath("/zen")).toBeNull();
  });

  it("redirects old page links while returning signed JSON directly to federated readers", async () => {
    const { alias: _alias, ...fields } = PROFILE;
    const profile = { ...fields, version: 3 as const, domain: "gsv-federation/3/profile" as const, url: "https://profile.example/profile" };
    const resolve = async () => ({ ...projection, profile });
    const path = { locator: { alias: "person" }, json: false };
    const page = await servePublicProfileRequest(new Request(PROFILE.url), path, resolve);
    expect(page.status).toBe(308);
    expect(page.headers.get("location")).toBe("/profile");
    const json = await servePublicProfileRequest(new Request(PROFILE.url, { headers: { accept: "application/json" } }), path, resolve);
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual(profile);
  });

  it("escapes published text, serves signed JSON separately, and rechecks before a 304", async () => {
    const resolve = vi.fn(async () => projection);
    const path = { locator: { alias: "person" }, json: false };
    const page = await servePublicProfileRequest(new Request(PROFILE.url), path, resolve);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("ownerUid");
    const json = await servePublicProfileRequest(new Request(PROFILE.url, { headers: { accept: "application/json" } }), path, resolve);
    expect(await json.json()).toEqual(PROFILE);
    expect(json.headers.get("etag")).not.toBe(page.headers.get("etag"));
    const cached = await servePublicProfileRequest(new Request(PROFILE.url, { headers: { "if-none-match": page.headers.get("etag")! } }), path, resolve);
    expect(cached.status).toBe(304);
    const revoked = await servePublicProfileRequest(new Request(PROFILE.url, { headers: { "if-none-match": page.headers.get("etag")! } }), path, async () => null);
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get("cache-control")).toBe("no-store");
    expect(resolve).toHaveBeenCalledTimes(6);
  });

  it("supports HEAD and refuses mutation methods without consulting the profile", async () => {
    const path = { locator: { alias: "person" }, json: false };
    const resolve = vi.fn(async () => projection);
    const head = await servePublicProfileRequest(new Request(PROFILE.url, { method: "HEAD" }), path, resolve);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    resolve.mockClear();
    const post = await servePublicProfileRequest(new Request(PROFILE.url, { method: "POST" }), path, resolve);
    expect(post.status).toBe(405);
    expect(resolve).not.toHaveBeenCalled();
  });
});
