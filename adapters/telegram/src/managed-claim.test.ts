import { describe, expect, it } from "vitest";
import {
  createManagedTelegramClaimToken,
  managedTelegramClaimUrl,
  parseManagedTelegramClaimToken,
  verifyManagedTelegramClaimToken,
} from "./managed-claim";

const SIGNING_KEY = "test-signing-key-with-at-least-thirty-two-bytes";
const PEER_ID = "a".repeat(64);

describe("managed Telegram claims", () => {
  it("signs a peer-bound token without putting account state in it", async () => {
    const claim = {
      durableObjectId: PEER_ID,
      claimId: "claim_1234567890abcdef",
      expiresAt: 1_800_000_000_000,
    };
    const token = await createManagedTelegramClaimToken(claim, SIGNING_KEY);

    expect(parseManagedTelegramClaimToken(token)).toEqual(claim);
    expect(await verifyManagedTelegramClaimToken(token, SIGNING_KEY)).toEqual(claim);
    expect(token).not.toContain("installation");
    expect(token).not.toContain("username");
  });

  it("rejects tampering and tokens signed by another service", async () => {
    const token = await createManagedTelegramClaimToken({
      durableObjectId: PEER_ID,
      claimId: "claim_1234567890abcdef",
      expiresAt: 1_800_000_000_000,
    }, SIGNING_KEY);

    expect(await verifyManagedTelegramClaimToken(
      token.replace("claim_123", "claim_456"),
      SIGNING_KEY,
    )).toBeNull();
    expect(await verifyManagedTelegramClaimToken(
      token,
      "another-test-signing-key-with-thirty-two-bytes",
    )).toBeNull();
  });

  it("places the bearer in a URL fragment on an HTTPS account origin", async () => {
    const token = await createManagedTelegramClaimToken({
      durableObjectId: PEER_ID,
      claimId: "claim_1234567890abcdef",
      expiresAt: 1_800_000_000_000,
    }, SIGNING_KEY);

    expect(managedTelegramClaimUrl("https://accounts.gsv.space", token)).toBe(
      `https://accounts.gsv.space/telegram#claim=${encodeURIComponent(token)}`,
    );
    expect(() => managedTelegramClaimUrl("http://accounts.gsv.space", token))
      .toThrow("HTTPS origin");
    expect(() => managedTelegramClaimUrl(
      "https://accounts.gsv.space/path",
      token,
    )).toThrow("HTTPS origin");
  });
});
