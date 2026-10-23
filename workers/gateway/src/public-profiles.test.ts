import { describe, expect, it, vi } from "vitest";
import type { ShipProfileRecord } from "@humansandmachines/gsv/protocol";
import type { ProfileAvatarFile } from "./kernel/profile-store";
import type { PublicProfileProjection } from "./kernel/profiles";
import { matchPublicProfilePath, servePublicProfileRequest } from "./public-profiles";

const PROFILE_URL = "https://person.ship.example/profile";
const RECORD: ShipProfileRecord = {
  $type: "space.ship.profile", displayName: "Person <script>alert(1)</script>",
  about: "<script>alert(1)</script><img src=x onerror=alert(1)>\nHello", contactPolicy: "invitation",
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const AVATAR: ProfileAvatarFile = { cid: "bafkreiavatar", mimeType: "image/png", size: PNG.byteLength, bytes: PNG };
const PROJECTION: PublicProfileProjection = { url: PROFILE_URL, handle: "person", cid: "bafyreirecord", record: RECORD };

function source(page: PublicProfileProjection | null = PROJECTION, avatar: ProfileAvatarFile | null = null) {
  return { page: vi.fn(async () => page), avatar: vi.fn(async () => avatar) };
}

describe("public profile serving", () => {
  it("matches the page, its picture and old alias links without admitting ambiguous paths", () => {
    expect(matchPublicProfilePath("/profile")).toBe("page");
    expect(matchPublicProfilePath("/profile/avatar")).toBe("avatar");
    expect(matchPublicProfilePath("/@person")).toBe("alias");
    for (const path of ["/@", "/@person/extra", "/@%70erson", "/@PERSON"]) expect(matchPublicProfilePath(path)).toBe("invalid");
    for (const path of ["/zen", "/profile/", "/profile.json", "/_gsv/federation/v2/subjects/subject%3Aone"]) expect(matchPublicProfilePath(path)).toBeNull();
  });

  it("renders the published record as an escaped page, and only as a page", async () => {
    const response = await servePublicProfileRequest(new Request(PROFILE_URL, { headers: { accept: "application/json" } }), "page", source());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("vary")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
    const html = await response.text();
    expect(html).toContain("<h1>@person</h1>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('class="avatar"');
    expect(html).not.toContain("application/json");
    expect(html).not.toContain("_gsv/federation");
    expect(html).toContain('<p class="restricted" data-info-row>Message requests restricted');
    expect(html).not.toContain("<form");
  });

  it("offers message requests only for an open profile, and reads an unknown policy as closed", async () => {
    const open = await (await servePublicProfileRequest(new Request(PROFILE_URL), "page", source({ ...PROJECTION, record: { ...RECORD, contactPolicy: "requests" } }), "https://ship.example")).text();
    expect(open).toContain(`data-profile="${PROFILE_URL}"`);
    expect(open).toContain('data-handle-domain="ship.example"');
    expect(open).toContain('src="/social/connect.js"');
    expect(open).toContain('<a class="brand wordmark" href="https://ship.example">Ship</a>');
    const unknown = await (await servePublicProfileRequest(new Request(PROFILE_URL), "page", source({ ...PROJECTION, record: { ...RECORD, contactPolicy: "everyone" } }))).text();
    expect(unknown).toContain("Message requests restricted");
    expect(unknown).not.toContain("<form");
    const unnamed = await (await servePublicProfileRequest(new Request(PROFILE_URL), "page", source({ url: PROFILE_URL, cid: "bafyreirecord", record: { ...RECORD, displayName: "Person" } }))).text();
    expect(unnamed).toContain("<h1>Person</h1>");
  });

  it("shows the record's picture from the Ship's own host and serves it sandboxed", async () => {
    const page = await (await servePublicProfileRequest(new Request(PROFILE_URL), "page", source({ ...PROJECTION, avatar: { cid: AVATAR.cid, mimeType: AVATAR.mimeType, size: AVATAR.size } }))).text();
    expect(page).toContain('<img class="avatar" src="/profile/avatar" alt=""');
    const avatarUrl = "https://person.ship.example/profile/avatar";
    const response = await servePublicProfileRequest(new Request(avatarUrl), "avatar", source(PROJECTION, AVATAR));
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/png", "content-length": String(PNG.byteLength), etag: `"${AVATAR.cid}"`,
      "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    const cached = await servePublicProfileRequest(new Request(avatarUrl, { headers: { "if-none-match": `"${AVATAR.cid}"` } }), "avatar", source(PROJECTION, AVATAR));
    expect(cached.status).toBe(304);
    const head = await servePublicProfileRequest(new Request(avatarUrl, { method: "HEAD" }), "avatar", source(PROJECTION, AVATAR));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const missing = await servePublicProfileRequest(new Request(avatarUrl), "avatar", source());
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("sends another host of the Ship and old alias links to the profile", async () => {
    const moved = await servePublicProfileRequest(new Request("https://person.old.example/profile"), "page", source());
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe(PROFILE_URL);
    expect(moved.headers.get("cache-control")).toBe("no-store");
    const profiles = source();
    const alias = await servePublicProfileRequest(new Request("https://person.ship.example/@person"), "alias", profiles);
    expect(alias.status).toBe(308);
    expect(alias.headers.get("location")).toBe("/profile");
    expect(profiles.page).not.toHaveBeenCalled();
    expect((await servePublicProfileRequest(new Request("https://person.ship.example/@PERSON"), "invalid", profiles)).status).toBe(404);
  });

  it("rechecks the published profile before a 304", async () => {
    const page = await servePublicProfileRequest(new Request(PROFILE_URL), "page", source());
    const etag = page.headers.get("etag")!;
    const cached = await servePublicProfileRequest(new Request(PROFILE_URL, { headers: { "if-none-match": etag } }), "page", source());
    expect(cached.status).toBe(304);
    const edited = await servePublicProfileRequest(new Request(PROFILE_URL, { headers: { "if-none-match": etag } }), "page", source({ ...PROJECTION, record: { ...RECORD, about: "Edited" } }));
    expect(edited.status).toBe(200);
    const unpublished = await servePublicProfileRequest(new Request(PROFILE_URL, { headers: { "if-none-match": etag } }), "page", source(null));
    expect(unpublished.status).toBe(404);
    expect(unpublished.headers.get("cache-control")).toBe("no-store");
  });

  it("supports HEAD and refuses mutation methods without consulting the profile", async () => {
    const head = await servePublicProfileRequest(new Request(PROFILE_URL, { method: "HEAD" }), "page", source());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const profiles = source();
    const post = await servePublicProfileRequest(new Request(PROFILE_URL, { method: "POST" }), "page", profiles);
    expect(post.status).toBe(405);
    expect(profiles.page).not.toHaveBeenCalled();
    expect(profiles.avatar).not.toHaveBeenCalled();
  });
});
