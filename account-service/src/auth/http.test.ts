import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("account auth HTTP boundary", () => {
  it("publishes only the browser-safe authentication configuration", async () => {
    const response = await SELF.fetch(
      "https://accounts.gsv.space/api/public/config",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the exact account origin for authentication mutations", async () => {
    const missing = await SELF.fetch(
      "https://accounts.gsv.space/api/auth/passkeys/authenticate/options",
      { method: "POST" },
    );
    expect(missing.status).toBe(403);

    const sibling = await SELF.fetch(
      "https://accounts.gsv.space/api/auth/passkeys/authenticate/options",
      {
        method: "POST",
        headers: { Origin: "https://hank.gsv.space" },
      },
    );
    expect(sibling.status).toBe(403);

    const nonOriginUrl = await SELF.fetch(
      "https://accounts.gsv.space/api/auth/passkeys/authenticate/options",
      {
        method: "POST",
        headers: { Origin: "https://accounts.gsv.space/path" },
      },
    );
    expect(nonOriginUrl.status).toBe(403);
  });

  it("generates a discoverable passkey challenge in the Workers runtime", async () => {
    const response = await SELF.fetch(
      "https://accounts.gsv.space/api/auth/passkeys/authenticate/options",
      {
        method: "POST",
        headers: {
          Origin: "https://accounts.gsv.space",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnstileToken: "gsv-test-turnstile-token" }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      challengeId: expect.stringMatching(/^challenge_/),
      options: {
        challenge: expect.any(String),
        rpId: "accounts.gsv.space",
        userVerification: "required",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects authentication challenges without server-validated bot proof", async () => {
    const response = await SELF.fetch(
      "https://accounts.gsv.space/api/auth/passkeys/authenticate/options",
      {
        method: "POST",
        headers: {
          Origin: "https://accounts.gsv.space",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnstileToken: "invalid" }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Verification failed" });
  });

  it("returns only public session state when no account cookie exists", async () => {
    const response = await SELF.fetch("https://accounts.gsv.space/api/session");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });
});
