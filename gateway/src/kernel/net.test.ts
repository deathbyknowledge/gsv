import { describe, expect, it } from "vitest";
import { responseFromNetFetchResult } from "./net";

describe("responseFromNetFetchResult", () => {
  it("rebuilds null-body status responses without a body", async () => {
    for (const status of [204, 205, 304]) {
      const response = responseFromNetFetchResult({
        ok: status < 300,
        url: "https://example.test/no-content",
        status,
        statusText: status === 304 ? "Not Modified" : "No Content",
        headers: {},
        bodyBase64: "",
        bodyBytes: 0,
      });

      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }
  });
});
