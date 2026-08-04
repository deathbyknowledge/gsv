import { describe, expect, it, vi } from "vitest";
import type { AuthAbuseProtection } from "../auth/abuse";
import { ACCOUNT_SESSION_COOKIE } from "../auth/session-cookie";
import { InstallationExportHttp } from "./http";
import type { InstallationExportService } from "./service";

const ACCOUNT_ORIGIN = "https://accounts.gsv.space";

describe("installation export HTTP boundary", () => {
  it("streams an attachment only from the exact account origin", async () => {
    const fixture = httpFixture();
    const rejected = await fixture.http.handle(exportRequest("https://owner.gsv.space"));
    expect(rejected?.status).toBe(403);
    expect(fixture.exports.create).not.toHaveBeenCalled();

    const accepted = await fixture.http.handle(exportRequest());
    expect(accepted?.status).toBe(200);
    expect(accepted?.headers.get("content-type")).toBe("application/x-tar");
    expect(accepted?.headers.get("content-disposition")).toMatch(
      /^attachment; filename="gsv-owner-20300129T080000Z\.tar"$/,
    );
    const body = new TextDecoder().decode(await accepted!.arrayBuffer());
    expect(body).toBe("streamed archive");
    expect(fixture.abuse.check).toHaveBeenCalledWith(expect.objectContaining({
      operation: "installation_export",
      subject: "session-token",
    }));
    expect(fixture.exports.create).toHaveBeenCalledWith({
      sessionToken: "session-token",
      installationId: "inst_owner",
    });
  });

  it("requires a JSON POST body", async () => {
    const fixture = httpFixture();
    const response = await fixture.http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/installations/inst_owner/export`,
      {
        method: "POST",
        headers: {
          Origin: ACCOUNT_ORIGIN,
          Cookie: `${ACCOUNT_SESSION_COOKIE}=session-token`,
        },
      },
    ));
    expect(response?.status).toBe(400);
    expect(fixture.exports.create).not.toHaveBeenCalled();
  });
});

function httpFixture() {
  const exports = {
    create: vi.fn(async () => ({
      installation: { handle: "owner" },
      exportedAt: 1_895_904_000_000,
      response: new Response("streamed archive", {
        headers: {
          "content-type": "application/x-tar",
          "x-gsv-export-format": "1",
        },
      }),
    })),
  };
  const abuse = { check: vi.fn(async () => undefined) };
  return {
    exports,
    abuse,
    http: new InstallationExportHttp(
      exports as unknown as InstallationExportService,
      abuse as unknown as AuthAbuseProtection,
      ACCOUNT_ORIGIN,
    ),
  };
}

function exportRequest(origin = ACCOUNT_ORIGIN): Request {
  return new Request(`${ACCOUNT_ORIGIN}/api/installations/inst_owner/export`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: `${ACCOUNT_SESSION_COOKIE}=session-token`,
    },
    body: "{}",
  });
}
