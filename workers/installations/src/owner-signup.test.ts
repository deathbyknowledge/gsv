import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleOwnerSignupRequest } from "./owner-signup";
import { parseHandle } from "./domain";

const origin = "https://accounts.example.com";
const alias = "https://signup.example.com";
const config = { GSV_ADMIN_ORIGIN: origin, GSV_OWNER_SIGNUP_ORIGIN: alias,
  GSV_PUBLIC_CONFIG: JSON.stringify({ primaryDomain: "fleet.example", operatorName: "Example Operator" }), ASSETS: env.ASSETS };

describe("browser signup assets", () => {
  it("serves the built shared welcome screen and its assets under the owner prefix", async () => {
    const response = await handleOwnerSignupRequest(new Request(`${origin}/owner/signup/`), config, true);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response!.text();
    expect(html).toContain('"primaryDomain":"fleet.example"');
    expect(html).toContain('id="gsv-deployment"');
    const script = html.match(/src="(\/owner\/signup\/assets\/[^"]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    const asset = await handleOwnerSignupRequest(new Request(origin + script), config, true);
    expect(asset?.status).toBe(200);
    expect(asset?.headers.get("content-type")).toContain("javascript");
    expect((await handleOwnerSignupRequest(new Request(`${origin}/owner/signup/missing`), config, true))?.status).toBe(404);
  });

  it("serves signup and its assets on the dedicated hostname without redirecting", async () => {
    const response = await handleOwnerSignupRequest(new Request(`${alias}/?resume=1`), config, true);
    expect(response?.status).toBe(200);
    expect(response?.headers.has("location")).toBe(false);
    const html = await response!.text();
    expect(html).toContain('id="gsv-deployment"');
    const script = html.match(/src="(\/owner\/signup\/assets\/[^"]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    expect((await handleOwnerSignupRequest(new Request(alias + script), config, true))?.status).toBe(200);
    expect((await handleOwnerSignupRequest(new Request(`${alias}/owner/signup/fonts/DepartureMono-Regular.woff2`), config, true))?.status).toBe(200);
    expect((await handleOwnerSignupRequest(new Request(alias, { method: "HEAD" }), config, true))?.status).toBe(200);
    expect((await handleOwnerSignupRequest(new Request(alias), config, false))?.status).toBe(503);
    expect((await handleOwnerSignupRequest(new Request(alias, { method: "POST" }), config, true))?.status).toBe(404);
    for (const path of ["/admin", "/owner/login", "/owner/recover", "/other"]) {
      expect((await handleOwnerSignupRequest(new Request(alias + path), config, true))?.status).toBe(404);
    }
    expect(await handleOwnerSignupRequest(new Request(`${alias}/owner/api/session`), config, true)).toBeNull();
    expect(await handleOwnerSignupRequest(new Request(`${origin}/owner/api/session`), config, true)).toBeNull();
    expect(() => parseHandle("signup")).toThrow("reserved");
  });

  it("keeps old signup paths on the dedicated host at its root and preserves query parameters", async () => {
    for (const path of ["/owner/signup", "/owner/signup/"]) {
      const response = await handleOwnerSignupRequest(new Request(`${alias}${path}?resume=1&ref=friend`), config, true);
      expect(response?.headers.get("location")).toBe("/?resume=1&ref=friend");
    }
  });

  it("redirects explicitly configured legacy signup links to the new hostname", async () => {
    const legacy = { ...config, GSV_OWNER_SIGNUP_ORIGIN_ALIASES: '["https://signup.legacy.example"]' };
    const response = await handleOwnerSignupRequest(new Request("https://signup.legacy.example/?resume=1&ref=friend"), legacy, true);
    expect(response?.headers.get("location")).toBe(`${alias}/?resume=1&ref=friend`);
    expect((await handleOwnerSignupRequest(new Request("https://signup.legacy.example/owner/api/session"), legacy, true))?.status).toBe(404);
  });

  it("requires configured signup, the canonical origin and a read request", async () => {
    const url = `${origin}/owner/signup/`;
    expect((await handleOwnerSignupRequest(new Request(url), config, false))?.status).toBe(503);
    expect((await handleOwnerSignupRequest(new Request(url), { GSV_ADMIN_ORIGIN: origin }, true))?.status).toBe(503);
    expect((await handleOwnerSignupRequest(new Request(url, { method: "POST" }), config, true))?.status).toBe(404);
    expect((await handleOwnerSignupRequest(new Request("https://other.example.com/owner/signup/"), config, true))?.status).toBe(404);
    expect((await handleOwnerSignupRequest(new Request(`${origin}/owner/signup`), config, true))?.headers.get("location")).toBe("/owner/signup/");
  });

  it("keeps canonical Accounts paths available when the alias equals the Accounts origin", async () => {
    const sharedOrigin = { ...config, GSV_OWNER_SIGNUP_ORIGIN: origin };
    expect((await handleOwnerSignupRequest(new Request(`${origin}/owner/signup/`), sharedOrigin, true))?.status).toBe(200);
    expect(await handleOwnerSignupRequest(new Request(`${origin}/owner/api/session`), sharedOrigin, true)).toBeNull();
    expect(await handleOwnerSignupRequest(new Request(`${origin}/admin`), sharedOrigin, true)).toBeNull();
  });
});
