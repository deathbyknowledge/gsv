import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleOwnerSignupRequest } from "./owner-signup";
import { parseHandle } from "./domain";

const origin = "https://accounts.example.com";
const alias = "https://signup.example.com";
const config = { GSV_ADMIN_ORIGIN: origin, GSV_OWNER_SIGNUP_ORIGIN: alias, ASSETS: env.ASSETS };

describe("browser signup assets", () => {
  it("serves the built shared welcome screen and its assets under the owner prefix", async () => {
    const response = await handleOwnerSignupRequest(new Request(`${origin}/owner/signup/`), config, true);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response!.text();
    const script = html.match(/src="(\/owner\/signup\/assets\/[^\"]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    const asset = await handleOwnerSignupRequest(new Request(origin + script), config, true);
    expect(asset?.status).toBe(200);
    expect(asset?.headers.get("content-type")).toContain("javascript");
    expect((await handleOwnerSignupRequest(new Request(`${origin}/owner/signup/missing`), config, true))?.status).toBe(404);
  });

  it("exposes only the redirect on the alias and leaves other owner routes with their existing handler", async () => {
    const response = await handleOwnerSignupRequest(new Request(alias), config, true);
    expect(response?.headers.get("location")).toBe(`${origin}/owner/signup/`);
    for (const path of ["/admin", "/owner/api/session", "/owner/signup/"]) {
      expect((await handleOwnerSignupRequest(new Request(alias + path), config, true))?.status).toBe(404);
    }
    expect(await handleOwnerSignupRequest(new Request(`${origin}/owner/api/session`), config, true)).toBeNull();
    expect(() => parseHandle("signup")).toThrow("reserved");
  });

  it("requires configured signup, the canonical origin and a read request", async () => {
    const url = `${origin}/owner/signup/`;
    expect((await handleOwnerSignupRequest(new Request(url), config, false))?.status).toBe(503);
    expect((await handleOwnerSignupRequest(new Request(url), { GSV_ADMIN_ORIGIN: origin }, true))?.status).toBe(503);
    expect((await handleOwnerSignupRequest(new Request(url, { method: "POST" }), config, true))?.status).toBe(404);
    expect((await handleOwnerSignupRequest(new Request("https://other.example.com/owner/signup/"), config, true))?.status).toBe(404);
    expect((await handleOwnerSignupRequest(new Request(`${origin}/owner/signup`), config, true))?.headers.get("location")).toBe("/owner/signup/");
  });
});
