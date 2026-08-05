import { describe, expect, it } from "vitest";
import DevelopmentAccountService from "./development";
import {
  developmentAccountOrigin,
  withDevelopmentCookie,
  withDevelopmentSetCookie,
} from "./development";

describe("managed development ingress", () => {
  const boundary = {
    ENVIRONMENT: "test",
    GSV_ACCOUNT_ORIGIN: "http://localhost:8976",
    GSV_BASE_DOMAIN: "localhost",
    GSV_INSTALLATION_ORIGIN_TEMPLATE: "http://{handle}.localhost:8976",
  };

  it("accepts only a test environment scoped to the local ingress", () => {
    expect(developmentAccountOrigin(boundary)).toBe("http://localhost:8976");
  });

  it.each([
    ["production environment", { ENVIRONMENT: "production" }],
    ["public account origin", { GSV_ACCOUNT_ORIGIN: "https://accounts.gsv.space" }],
    ["public base domain", { GSV_BASE_DOMAIN: "gsv.space" }],
    ["foreign installation template", {
      GSV_INSTALLATION_ORIGIN_TEMPLATE: "http://{handle}.example.com:8976",
    }],
    ["mismatched installation port", {
      GSV_INSTALLATION_ORIGIN_TEMPLATE: "http://{handle}.localhost:8787",
    }],
  ])("rejects a %s", (_label, override) => {
    expect(() => developmentAccountOrigin({ ...boundary, ...override }))
      .toThrow();
  });

  it("rejects the bootstrap before touching services outside test", async () => {
    const service = new DevelopmentAccountService(
      {} as ExecutionContext,
      { ...boundary, ENVIRONMENT: "production" } as never,
    );
    const response = await service.fetch(new Request(
      "http://localhost:8976/__gsv/development/bootstrap",
      {
        method: "POST",
        headers: { origin: "http://localhost:8976" },
      },
    ));

    expect(response.status).toBe(404);
  });

  it("requires an explicit click on a non-frameable bootstrap page", async () => {
    const service = new DevelopmentAccountService(
      {} as ExecutionContext,
      boundary as never,
    );
    const response = await service.fetch(new Request(
      "http://localhost:8976/__gsv/development",
    ));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy"))
      .toContain("frame-ancestors 'none'");
    expect(body).toContain("Open local GSV");
    expect(body).not.toContain("requestSubmit");
  });

  it("translates only the selected local request cookie", () => {
    const request = new Request("http://local.localhost:8787/", {
      headers: {
        cookie: "theme=dark; gsv-local-session=local-token; unrelated=value",
      },
    });

    expect(withDevelopmentCookie(
      request,
      "gsv-local-session",
      "__Host-gsv-session",
    ).headers.get("cookie")).toBe(
      "theme=dark; unrelated=value; __Host-gsv-session=local-token",
    );
  });

  it("turns a secure production cookie into a host-only HTTP local cookie", () => {
    const response = new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": "__Host-gsv-session=token; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax",
      },
    });
    const rewritten = withDevelopmentSetCookie(
      response,
      "__Host-gsv-session",
      "gsv-local-session",
    );

    expect(rewritten.status).toBe(303);
    expect(rewritten.headers.get("location")).toBe("/");
    expect(rewritten.headers.get("set-cookie")).toBe(
      "gsv-local-session=token; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
    );
  });
});
