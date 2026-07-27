import { describe, expect, it } from "vitest";
import { isRetiredCliDownloadPath } from "./index";

describe("gateway public routes", () => {
  it("retires only the old CLI mirror path", () => {
    expect(isRetiredCliDownloadPath("/public/gsv/downloads/cli/install.sh")).toBe(true);
    expect(isRetiredCliDownloadPath("/public/gsv/downloads/cli-old/install.sh")).toBe(false);
    expect(isRetiredCliDownloadPath("/public/gsv/assets/app.js")).toBe(false);
  });
});
