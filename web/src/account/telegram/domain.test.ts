import { describe, expect, it } from "vitest";
import {
  claimFromHash,
  initialInstallationId,
  locationWithoutHash,
  telegramIdentity,
} from "./domain";
import type { ManagedTelegramClaimInspection } from "./types";

const installation = {
  installationId: "inst_hank",
  handle: "hank",
  canonicalOrigin: "https://hank.gsv.space",
  state: "active" as const,
  role: "owner" as const,
};

describe("managed Telegram link domain", () => {
  it("reads only a bounded claim parameter from the fragment", () => {
    expect(claimFromHash("#claim=gsvtg1.token&ignored=value")).toBe(
      "gsvtg1.token",
    );
    expect(claimFromHash("#claim=%20token")).toBeNull();
    expect(claimFromHash(`#claim=${"x".repeat(2_049)}`)).toBeNull();
    expect(claimFromHash("#other=value")).toBeNull();
  });

  it("removes the entire fragment without changing path or query", () => {
    expect(locationWithoutHash({
      pathname: "/telegram",
      search: "?source=bot",
    })).toBe("/telegram?source=bot");
  });

  it("preselects one installation but requires a choice among several", () => {
    const one = inspection([installation]);
    expect(initialInstallationId(one)).toBe("inst_hank");
    expect(initialInstallationId(inspection([
      installation,
      { ...installation, installationId: "inst_other", handle: "other" },
    ]))).toBeNull();
  });

  it("preserves an eligible explicit selection after reauthentication", () => {
    expect(initialInstallationId(inspection([installation]), "inst_hank"))
      .toBe("inst_hank");
    expect(initialInstallationId(inspection([installation]), "inst_old"))
      .toBe("inst_hank");
  });

  it("prefers a Telegram display name without requiring one", () => {
    expect(telegramIdentity({
      claimId: "claim",
      actorName: "Hank",
      actorHandle: "@hank",
      expiresAt: 1,
      linked: false,
    })).toEqual({ primary: "Hank", secondary: "@hank" });
    expect(telegramIdentity({
      claimId: "claim",
      expiresAt: 1,
      linked: false,
    })).toEqual({ primary: "Your Telegram account" });
  });
});

function inspection(
  installations: ManagedTelegramClaimInspection["installations"],
): ManagedTelegramClaimInspection {
  return {
    claim: {
      claimId: "claim",
      expiresAt: Date.now() + 60_000,
      linked: false,
    },
    installations,
  };
}
