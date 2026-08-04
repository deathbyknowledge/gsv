import { describe, expect, it, vi } from "vitest";
import { accountPage, publicTurnstileSiteKey } from "./account-ui";

describe("account interface boundary", () => {
  it("validates the public widget identifier without exposing a secret", () => {
    expect(publicTurnstileSiteKey(undefined)).toBeNull();
    expect(publicTurnstileSiteKey(" 1x00000000000000000000AA "))
      .toBe("1x00000000000000000000AA");
    expect(() => publicTurnstileSiteKey("short")).toThrow(
      "GSV_TURNSTILE_SITE_KEY is invalid",
    );
  });

  it("serves the dedicated HTML asset with credential-safe headers", async () => {
    const requestedAssets: Request[] = [];
    const fetchAsset = vi.fn(async (request: Request) => {
      requestedAssets.push(request);
      return new Response(
        "<!doctype html><title>GSV</title>",
        { headers: { "content-type": "text/html" } },
      );
    });
    const response = await accountPage(
      new Request("https://accounts.gsv.space/telegram"),
      { fetch: fetchAsset } as unknown as Fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>GSV</title>");
    expect(new URL(requestedAssets[0].url).pathname)
      .toBe("/account/index.html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy"))
      .toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy"))
      .toContain("script-src 'self' https://challenges.cloudflare.com");
  });

  it("never sends an HTML body for HEAD", async () => {
    const response = await accountPage(
      new Request("https://accounts.gsv.space/telegram", { method: "HEAD" }),
      {
        fetch: vi.fn(async () => new Response("secretless html")),
      } as unknown as Fetcher,
    );
    expect(await response.text()).toBe("");
  });

  it("serves the same credential-safe shell for billing", async () => {
    const response = await accountPage(
      new Request("https://accounts.gsv.space/billing"),
      {
        fetch: vi.fn(async () => new Response("billing shell")),
      } as unknown as Fetcher,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("billing shell");
    expect(response.headers.get("content-security-policy"))
      .toContain("default-src 'none'");
  });
});
