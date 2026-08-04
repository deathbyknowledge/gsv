import { describe, expect, it, vi } from "vitest";
import type { AuthAbuseProtection } from "../auth/abuse";
import { ACCOUNT_SESSION_COOKIE } from "../auth/session-cookie";
import { InstallationLifecycleHttp } from "./http";
import {
  InstallationLifecycleUnavailableError,
  type InstallationLifecycleService,
} from "./service";

const ACCOUNT_ORIGIN = "https://accounts.gsv.space";

describe("installation lifecycle HTTP boundary", () => {
  it("accepts confirmed deletion only from the exact account origin", async () => {
    const fixture = httpFixture();
    const sibling = deletionRequest("https://owner.gsv.space");
    const rejected = await fixture.http.handle(sibling);
    expect(rejected?.status).toBe(403);
    expect(fixture.lifecycle.requestUserDeletion).not.toHaveBeenCalled();

    const accepted = await fixture.http.handle(deletionRequest());
    expect(accepted?.status).toBe(202);
    await expect(accepted?.json()).resolves.toMatchObject({
      deletion: { installationId: "inst_owner", state: "recoverable" },
    });
    expect(fixture.abuse.check).toHaveBeenCalledWith(expect.objectContaining({
      operation: "installation_delete",
      subject: "session-token",
    }));
    expect(fixture.lifecycle.requestUserDeletion).toHaveBeenCalledWith({
      sessionToken: "session-token",
      installationId: "inst_owner",
      confirmedHandle: "owner",
      idempotencyKey: "88b91b0e-509f-49ff-ae7f-b96a27762286",
    });
  });

  it("reads status without a mutation origin and invokes explicit recovery", async () => {
    const fixture = httpFixture();
    const status = await fixture.http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/installations/inst_owner/deletion`,
      { headers: sessionHeaders() },
    ));
    expect(status?.status).toBe(200);
    expect(fixture.lifecycle.get).toHaveBeenCalledWith({
      sessionToken: "session-token",
      installationId: "inst_owner",
    });

    const recovered = await fixture.http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/installations/inst_owner/deletion/recover`,
      {
        method: "POST",
        headers: {
          ...sessionHeaders(),
          Origin: ACCOUNT_ORIGIN,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ));
    expect(recovered?.status).toBe(200);
    expect(fixture.abuse.check).toHaveBeenCalledWith(expect.objectContaining({
      operation: "installation_recover",
    }));
    expect(fixture.lifecycle.recoverUserDeletion).toHaveBeenCalledWith({
      sessionToken: "session-token",
      installationId: "inst_owner",
    });
  });

  it("returns a retryable response when resource recovery is unavailable", async () => {
    const fixture = httpFixture();
    fixture.lifecycle.recoverUserDeletion.mockRejectedValueOnce(
      new InstallationLifecycleUnavailableError("temporarily unavailable"),
    );
    const response = await fixture.http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/installations/inst_owner/deletion/recover`,
      {
        method: "POST",
        headers: {
          ...sessionHeaders(),
          Origin: ACCOUNT_ORIGIN,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ));
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: "Lifecycle service temporarily unavailable",
    });
  });
});

function httpFixture() {
  const deletion = {
    operationId: "deletion_owner",
    installationId: "inst_owner",
    requestKind: "user" as const,
    state: "recoverable" as const,
    recoverableUntil: Date.now() + 60_000,
    createdAt: Date.now(),
    completedAt: null,
  };
  const lifecycle = {
    requestUserDeletion: vi.fn(async () => deletion),
    get: vi.fn(async () => deletion),
    recoverUserDeletion: vi.fn(async () => ({
      ...deletion,
      state: "recovered" as const,
      completedAt: Date.now(),
    })),
  };
  const abuse = {
    check: vi.fn(async () => undefined),
  };
  return {
    lifecycle,
    abuse,
    http: new InstallationLifecycleHttp(
      lifecycle as unknown as InstallationLifecycleService,
      abuse as unknown as AuthAbuseProtection,
      ACCOUNT_ORIGIN,
    ),
  };
}

function deletionRequest(origin = ACCOUNT_ORIGIN): Request {
  return new Request(`${ACCOUNT_ORIGIN}/api/installations/inst_owner/deletion`, {
    method: "POST",
    headers: {
      ...sessionHeaders(),
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      confirmedHandle: "owner",
      idempotencyKey: "88b91b0e-509f-49ff-ae7f-b96a27762286",
    }),
  });
}

function sessionHeaders(): Record<string, string> {
  return {
    Cookie: `${ACCOUNT_SESSION_COOKIE}=session-token`,
  };
}
