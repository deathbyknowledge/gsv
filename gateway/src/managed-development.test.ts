import { describe, expect, it } from "vitest";
import {
  hasValidDevelopmentWebSocketOrigin,
  withDevelopmentCookie,
  withDevelopmentSetCookie,
} from "./managed-development";

describe("managed development host router", () => {
  it("maps the local installation cookie onto the production gateway boundary", () => {
    const request = new Request("http://local.localhost:8976/ws", {
      headers: { cookie: "theme=dark; gsv-local-session=local-token" },
    });

    expect(withDevelopmentCookie(request).headers.get("cookie")).toBe(
      "theme=dark; __Host-gsv-session=local-token",
    );
  });

  it("maps the production response cookie back to plain HTTP localhost", () => {
    const response = withDevelopmentSetCookie(new Response(null, {
      status: 303,
      headers: {
        "set-cookie": "__Host-gsv-session=token; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax",
      },
    }));

    expect(response.headers.get("set-cookie")).toBe(
      "gsv-local-session=token; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
    );
  });

  it("requires the exact installation origin for cookie-authenticated WebSockets", () => {
    const headers = {
      cookie: "gsv-local-session=token",
      origin: "http://local.localhost:8976",
      upgrade: "websocket",
    };
    expect(hasValidDevelopmentWebSocketOrigin(new Request(
      "http://local.localhost:8976/ws",
      { headers },
    ))).toBe(true);
    expect(hasValidDevelopmentWebSocketOrigin(new Request(
      "http://local.localhost:8976/ws",
      { headers: { ...headers, origin: "http://evil.localhost:8976" } },
    ))).toBe(false);
    expect(hasValidDevelopmentWebSocketOrigin(new Request(
      "http://local.localhost:8976/ws",
      { headers: { ...headers, origin: "http://local.localhost:9000" } },
    ))).toBe(false);
    expect(hasValidDevelopmentWebSocketOrigin(new Request(
      "http://local.localhost:8976/ws",
      { headers: { cookie: headers.cookie, upgrade: headers.upgrade } },
    ))).toBe(false);
  });

  it("leaves token-authenticated WebSockets independent of browser origins", () => {
    expect(hasValidDevelopmentWebSocketOrigin(new Request(
      "http://local.localhost:8976/ws",
      { headers: { upgrade: "websocket" } },
    ))).toBe(true);
  });
});
