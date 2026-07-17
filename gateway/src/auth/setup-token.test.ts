import { describe, expect, it } from "vitest";
import { authorizeSetupToken, SetupTokenError } from "./setup-token";

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function envWithSetupTokenPolicy(hash?: unknown, expiresAt: unknown = "2000000000000"): Env {
  return (hash === undefined
    ? {}
    : {
        GSV_SETUP_TOKEN_HASH: hash,
        GSV_SETUP_TOKEN_EXPIRES_AT: expiresAt,
      }) as Env;
}

describe("authorizeSetupToken", () => {
  it("preserves self-hosted setup when the binding is absent", async () => {
    await expect(authorizeSetupToken(envWithSetupTokenPolicy(), undefined)).resolves.toBeUndefined();
  });

  it("accepts the raw token matching the configured SHA-256 hash", async () => {
    const token = "managed-setup-token";
    const env = envWithSetupTokenPolicy(await sha256Hex(token));

    await expect(authorizeSetupToken(env, token)).resolves.toBeUndefined();
  });

  it("prefers the durable managed policy over legacy environment secrets", async () => {
    const token = "A".repeat(43);
    const durablePolicy = {
      version: 3,
      hash: await sha256Hex(token),
      expiresAt: 2_000_000_000_000,
    };
    const invalidLegacyEnv = envWithSetupTokenPolicy("invalid", "invalid");

    await expect(authorizeSetupToken(
      invalidLegacyEnv,
      token,
      1_000,
      durablePolicy,
    )).resolves.toBeUndefined();
    await expect(authorizeSetupToken(
      invalidLegacyEnv,
      "B".repeat(43),
      1_000,
      durablePolicy,
    )).rejects.toMatchObject({ status: 403 });
  });

  it("rejects non-canonical durable managed tokens before hashing their contents", async () => {
    const durablePolicy = {
      version: 1,
      hash: await sha256Hex("A".repeat(43)),
      expiresAt: 2_000_000_000_000,
    };

    await expect(authorizeSetupToken(
      {} as Env,
      "x".repeat(256 * 1024),
      1_000,
      durablePolicy,
    )).rejects.toMatchObject({
      status: 403,
      message: "Setup authorization failed",
    });
  });

  it("rejects missing and incorrect tokens with the same authorization error", async () => {
    const env = envWithSetupTokenPolicy(await sha256Hex("managed-setup-token"));

    for (const token of [undefined, "", "wrong-token"]) {
      await expect(authorizeSetupToken(env, token)).rejects.toMatchObject({
        status: 403,
        message: "Setup authorization failed",
      } satisfies Partial<SetupTokenError>);
    }
  });

  it("rejects malformed configured hashes as a deployment error", async () => {
    for (const value of ["not-a-digest", "A".repeat(64), 42]) {
      await expect(authorizeSetupToken(envWithSetupTokenPolicy(value), "token")).rejects.toMatchObject({
        status: 500,
        message: "GSV_SETUP_TOKEN_HASH must be a lowercase 64-character SHA-256 hex digest",
      } satisfies Partial<SetupTokenError>);
    }
  });

  it("rejects expired tokens with the same authorization error", async () => {
    const token = "managed-setup-token";
    const env = envWithSetupTokenPolicy(await sha256Hex(token), "1000");

    await expect(authorizeSetupToken(env, token, 1000)).rejects.toMatchObject({
      status: 403,
      message: "Setup authorization failed",
    } satisfies Partial<SetupTokenError>);
  });

  it("fails closed when the managed expiry secret is absent or malformed", async () => {
    const hash = await sha256Hex("managed-setup-token");
    for (const value of [undefined, "", "01", "not-a-time", 2_000_000_000_000]) {
      const env = {
        GSV_SETUP_TOKEN_HASH: hash,
        ...(value === undefined ? {} : { GSV_SETUP_TOKEN_EXPIRES_AT: value }),
      } as Env;
      await expect(authorizeSetupToken(env, "managed-setup-token")).rejects.toMatchObject({
        status: 500,
        message: "GSV_SETUP_TOKEN_EXPIRES_AT must be a positive canonical millisecond timestamp",
      } satisfies Partial<SetupTokenError>);
    }
  });
});
