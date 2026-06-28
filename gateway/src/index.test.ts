import { describe, expect, it } from "vitest";
import { packageAppClientResponseHeaders, packageWorkerPath } from "./index";

describe("gateway app session routing", () => {
  it("preserves the package app root slash when proxying app sessions", () => {
    expect(packageWorkerPath("/apps/chat", "/")).toBe("/apps/chat/");
    expect(packageWorkerPath("/apps/chat", "")).toBe("/apps/chat/");
  });

  it("keeps nested app session paths under the package route", () => {
    expect(packageWorkerPath("/apps/chat", "/assets/main.js")).toBe("/apps/chat/assets/main.js");
  });

  it("strips package-controlled cookie headers from app session responses", () => {
    const headers = packageAppClientResponseHeaders(new Response("ok", {
      headers: {
        "content-length": "2",
        "set-cookie": "gsv_session=bad",
        "set-cookie2": "gsv_legacy=bad",
        "x-package": "ok",
      },
    }));

    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("set-cookie2")).toBeNull();
    expect(headers.get("x-package")).toBe("ok");
  });
});
