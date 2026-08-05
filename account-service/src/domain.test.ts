import { describe, expect, it } from "vitest";
import { installationOriginFromTemplate } from "./domain";

describe("managed installation origins", () => {
  it("permits an explicit localhost origin with a development port", () => {
    expect(installationOriginFromTemplate(
      "hank",
      "localhost",
      "http://{handle}.localhost:8787",
    )).toBe("http://hank.localhost:8787");
  });

  it.each([
    "http://{handle}.gsv.space",
    "https://{handle}.example.com",
    "https://{handle}.gsv.space/path",
    "https://gsv.space",
    "https://{handle}.{handle}.gsv.space",
  ])("rejects an unsafe installation origin template %s", (template) => {
    expect(() => installationOriginFromTemplate("hank", "gsv.space", template))
      .toThrow("GSV_INSTALLATION_ORIGIN_TEMPLATE is invalid");
  });
});
