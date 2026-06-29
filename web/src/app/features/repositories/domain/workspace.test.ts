import { describe, expect, it } from "vitest";
import { createBrowserTab, retargetBrowserTab } from "./workspace";

describe("repository workspace", () => {
  it("retargets an existing browser tab to the requested path", () => {
    const tab = {
      ...createBrowserTab("root/gsv", "main", "src"),
      commandInput: "gateway",
      commandInputKey: 2,
      searchQuery: "gateway",
    };

    expect(retargetBrowserTab(tab, "/docs/reference")).toEqual({
      ...tab,
      path: "docs/reference",
      commandInput: "",
      commandInputKey: 3,
      searchQuery: "",
    });
  });
});
