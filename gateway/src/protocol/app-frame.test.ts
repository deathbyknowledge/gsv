import { describe, expect, it } from "vitest";
import {
  isAppFrameContextExpired,
  type AppFrameContext,
} from "./app-frame";

const NOW = 1_800_000_000_000;

function appFrame(
  times: Pick<AppFrameContext, "issuedAt" | "expiresAt">,
): AppFrameContext {
  return {
    uid: 1000,
    username: "alice",
    kernelOwnerUid: 1000,
    kernelUsername: "alice",
    kernelGeneration: 3,
    packageId: "pkg-chat",
    packageName: "chat",
    packageUpdatedAt: NOW - 10_000,
    packageArtifactHash: "sha256:chat-v1",
    entrypointName: "Chat",
    routeBase: "/apps/chat",
    ...times,
  };
}

describe("app frame lifetime validation", () => {
  it.each([
    {
      label: "expired",
      issuedAt: NOW - 2_000,
      expiresAt: NOW - 1,
    },
    {
      label: "NaN issued time",
      issuedAt: Number.NaN,
      expiresAt: NOW + 60_000,
    },
    {
      label: "NaN expiry time",
      issuedAt: NOW - 1_000,
      expiresAt: Number.NaN,
    },
    {
      label: "infinite issued time",
      issuedAt: Number.POSITIVE_INFINITY,
      expiresAt: NOW + 60_000,
    },
    {
      label: "infinite expiry time",
      issuedAt: NOW - 1_000,
      expiresAt: Number.POSITIVE_INFINITY,
    },
    {
      label: "issued too far in the future",
      issuedAt: NOW + 5 * 60_000 + 1,
      expiresAt: NOW + 6 * 60_000,
    },
  ])("rejects $label", ({ issuedAt, expiresAt }) => {
    expect(isAppFrameContextExpired(appFrame({ issuedAt, expiresAt }), NOW)).toBe(true);
  });

  it("accepts a finite, current lifetime", () => {
    expect(isAppFrameContextExpired(appFrame({
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 60_000,
    }), NOW)).toBe(false);
  });
});
