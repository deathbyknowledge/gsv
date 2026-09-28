import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../testing/testHarness";
import { SetupScreen } from "../../features/session/SetupScreen";
import { SetupFooter, SetupFooterProvider } from "./SetupFooter";

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("setup footer slot", () => {
  it("renders the host's note only when an entry supplies one", async () => {
    let tree: ComponentChildren;
    function Probe() { tree = SetupFooter(); return null; }
    const root = createTestRoot("Setup footer");
    try {
      await root.render(<Probe />);
      expect(collectText(tree)).toBe("");
      await root.render(<SetupFooterProvider footer={<a href="https://example.com/app">Get the app</a>}><Probe /></SetupFooterProvider>);
      expect(collectText(tree)).toBe("Get the app");
    } finally { await root.unmount(); }
  });

  it("is rendered by the setup screen under its form", () => {
    const tree = SetupScreen({ visible: true, busy: false, space: "new.gsv.space", username: "", password: "", passwordConfirm: "",
      error: null, onUsername: () => {}, onPassword: () => {}, onPasswordConfirm: () => {}, onSubmit: () => {} });
    const nodes = collectNodes(tree);
    expect(nodes.findIndex((node) => node.type === SetupFooter)).toBeGreaterThan(nodes.findIndex((node) => node.type === "form"));
  });
});
