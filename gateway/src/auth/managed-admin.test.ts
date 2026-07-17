import { describe, expect, it } from "vitest";
import { authorizeManagedAdmin } from "./managed-admin";

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function managedEnv(value?: unknown): Env {
  return (value === undefined ? {} : { GSV_MANAGED_ADMIN_TOKEN_HASH: value }) as Env;
}

describe("authorizeManagedAdmin", () => {
  it("leaves the managed surface unpublished when the secret is absent", async () => {
    const result = await authorizeManagedAdmin(new Request("https://gateway.test/"), managedEnv());
    expect(result).toEqual({ configured: false });
  });

  it("accepts only an exact bearer token matching the configured digest", async () => {
    const env = managedEnv(await sha256Hex("tenant-admin-token"));
    const request = new Request("https://gateway.test/", {
      headers: { authorization: "Bearer tenant-admin-token" },
    });
    await expect(authorizeManagedAdmin(request, env)).resolves.toEqual({
      configured: true,
      authorized: true,
      configurationValid: true,
    });
  });

  it("returns one generic result for missing, malformed, and incorrect credentials", async () => {
    const env = managedEnv(await sha256Hex("tenant-admin-token"));
    const headers = [undefined, "Basic dGVzdDp0ZXN0", "Bearer", "Bearer wrong"];
    for (const authorization of headers) {
      const request = new Request("https://gateway.test/", {
        headers: authorization ? { authorization } : undefined,
      });
      await expect(authorizeManagedAdmin(request, env)).resolves.toEqual({
        configured: true,
        authorized: false,
        configurationValid: true,
      });
    }
  });

  it("does not expose malformed deployment secrets", async () => {
    for (const value of ["invalid", "A".repeat(64), 42]) {
      await expect(authorizeManagedAdmin(
        new Request("https://gateway.test/", {
          headers: { authorization: "Bearer tenant-admin-token" },
        }),
        managedEnv(value),
      )).resolves.toEqual({
        configured: true,
        authorized: false,
        configurationValid: false,
      });
    }
  });
});
