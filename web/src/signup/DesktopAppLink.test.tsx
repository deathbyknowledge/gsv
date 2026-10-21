import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../app/testing/testHarness";
import { DesktopAppLink } from "./DesktopAppLink";

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("signup desktop app link", () => {
  it("points at the latest release page in a new tab without a referrer", async () => {
    let tree: ComponentChildren;
    function Harness() {
      tree = DesktopAppLink();
      return null;
    }
    const root = createTestRoot("Desktop app link");
    try {
      await root.render(<Harness />);
      const link = collectNodes(tree).find((node) => node.type === "a")!;
      expect(link.props.href).toBe("https://github.com/deathbyknowledge/gsv/releases/latest");
      expect(link.props).toMatchObject({ target: "_blank", rel: "noreferrer" });
      expect(collectText(link)).toBe("Try the beta desktop app");
      expect(collectText(tree)).toContain("macOS, Windows and Linux");
    } finally { await root.unmount(); }
  });
});
