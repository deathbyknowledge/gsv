import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/shadow";
import {
  ACCOUNT_USERNAME_MAX_CHARACTERS,
  LOGIN_CREDENTIAL_MAX_CHARACTERS,
} from "../auth/login";
import { AUTHENTICATION_FAILED_MESSAGE, AuthStore } from "./auth-store";
import type { Kernel } from "./do";

describe("Git HTTP authentication", () => {
  it("accepts passwords and tokens while hiding account and credential state", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    const token = await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      await auth.setPassword("root", await hashPassword("correct-password"));
      return (await auth.issueToken({ uid: 0, kind: "user" })).token;
    });
    const request = {
      owner: "root",
      repo: "private-repo",
      write: true,
    };

    await expect(kernel.authorizeGitHttp({
      ...request,
      username: "root",
      credential: "correct-password",
    })).resolves.toMatchObject({ ok: true, username: "root", uid: 0 });
    await expect(kernel.authorizeGitHttp({
      ...request,
      username: "root",
      credential: token,
    })).resolves.toMatchObject({ ok: true, username: "root", uid: 0 });

    const wrong = await kernel.authorizeGitHttp({
      ...request,
      username: "root",
      credential: "wrong-credential",
    });
    const unknown = await kernel.authorizeGitHttp({
      ...request,
      username: "unknown-user",
      credential: "wrong-credential",
    });
    expect(wrong).toEqual({
      ok: false,
      status: 401,
      message: AUTHENTICATION_FAILED_MESSAGE,
    });
    expect(unknown).toEqual(wrong);

    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    const padded = await kernel.authorizeGitHttp({
      ...request,
      trustedSourceAddress: "203.0.113.8",
      username: "root",
      credential: " correct-password ",
    });
    const oversized = await kernel.authorizeGitHttp({
      ...request,
      trustedSourceAddress: "203.0.113.8",
      username: "root",
      credential: "x".repeat(LOGIN_CREDENTIAL_MAX_CHARACTERS + 1),
    });
    const oversizedUsername = await kernel.authorizeGitHttp({
      ...request,
      trustedSourceAddress: "203.0.113.8",
      username: "a".repeat(ACCOUNT_USERNAME_MAX_CHARACTERS + 1),
      credential: "wrong-credential",
    });
    expect(padded).toEqual(wrong);
    expect(oversized).toEqual(wrong);
    expect(oversizedUsername).toEqual(wrong);
    expect(deriveBits).toHaveBeenCalledTimes(3);
    deriveBits.mockRestore();
  });
});
