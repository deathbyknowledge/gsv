import { describe, expect, it } from "vitest";
import { packageWorkerPath } from "./index";

describe("gateway app session routing", () => {
  it("preserves the package app root slash when proxying app sessions", () => {
    expect(packageWorkerPath("/apps/chat", "/")).toBe("/apps/chat/");
    expect(packageWorkerPath("/apps/chat", "")).toBe("/apps/chat/");
  });

  it("keeps nested app session paths under the package route", () => {
    expect(packageWorkerPath("/apps/chat", "/assets/main.js")).toBe("/apps/chat/assets/main.js");
  });
});
