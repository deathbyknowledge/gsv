import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot, collectText } from "../../../testing/testHarness";
import { HelpContent } from "./HelpContent";

vi.mock("../../../services/deployment", () => ({ publicDeployment: () => ({ privacyUrl: "https://example.com/privacy" }) }));
afterEach(() => vi.unstubAllGlobals());

it.each(["MacIntel", "Win32"])("keeps onboarding destinations and the complete, collapsed shortcut reference on %s", async (platform) => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { platform });
  const root = createTestRoot("Help");
  const onNavigate = vi.fn();
  const onSearch = vi.fn();
  let tree: ComponentChildren;
  function Harness() {
    tree = HelpContent({ connected: true, onNavigate, onSearch });
    return null;
  }
  try {
    await root.render(<Harness />);
    const nodes = collectNodes(tree);
    // SAFETY: Help's keyboard boundary only reads key and stops propagation; native activation remains enabled.
    const content = nodes.find((node) => node.props.class === "instrument-help-content") as VNode<JSX.HTMLAttributes<HTMLDivElement>>;
    for (const key of [" ", "Enter", "Tab", "Escape", "s"]) {
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();
      await act(() => content.props.onKeyDown?.({ key, stopPropagation, preventDefault } as unknown as JSX.TargetedKeyboardEvent<HTMLDivElement>));
      expect(stopPropagation).toHaveBeenCalledTimes(key === " " || key === "Enter" ? 1 : 0);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    const links = nodes.filter((node) => node.type === "a");
    const hrefs = links.map((node) => node.props.href);
    expect(hrefs).toEqual(expect.arrayContaining([
      "/chat/settings?section=messengers", "/memory", "/chat/settings?section=permissions",
      "https://example.com/privacy", "mailto:hello@humansandmachin.es", "https://discord.gg/hy9ExJJFvn",
    ]));
    expect(hrefs.some((href) => href?.includes("gsv-manual") && href.startsWith("/memory"))).toBe(true);
    const disclosures = nodes.filter((node) => node.type === "details");
    expect(disclosures).toHaveLength(2);
    expect(disclosures.every((node) => !(node.props as { open?: boolean }).open)).toBe(true);
    expect(nodes.filter((node) => node.type === "summary")).toHaveLength(2);
    const text = collectText(tree);
    for (const label of ["What can Ship help with?", "Getting started", "Chat · browse", "Chat · input", "Memory", "Expanded file", "Settings", "Keyboard shortcuts", "Need more help?"]) expect(text).toContain(label);
    expect(text).toContain(platform === "MacIntel" ? "⌘ Enter" : "Ctrl + Enter");
    expect(text).toContain(platform === "MacIntel" ? "⌘ F" : "Ctrl + F");
    expect(text).not.toContain("Your information is yours");
    // SAFETY: The native link handler reads only these event fields and the href.
    const link = links.find((node) => node.props.href === "/chat/settings?section=permissions") as VNode<JSX.AnchorHTMLAttributes<HTMLAnchorElement>>;
    const preventDefault = vi.fn();
    const event = { button: 0, defaultPrevented: false, preventDefault, currentTarget: { getAttribute: () => link.props.href } };
    await act(() => link.props.onClick?.(event as unknown as JSX.TargetedMouseEvent<HTMLAnchorElement>));
    expect(onNavigate).toHaveBeenCalledWith("/chat/settings?section=permissions");
    expect(preventDefault).toHaveBeenCalledOnce();
    onNavigate.mockClear();
    await act(() => link.props.onClick?.({ ...event, metaKey: true } as unknown as JSX.TargetedMouseEvent<HTMLAnchorElement>));
    expect(onNavigate).not.toHaveBeenCalled();
    const search = nodes.find((node) => node.type === "button" && node.props.class === "instrument-help-search");
    await act(() => search?.props.onClick?.());
    expect(onSearch).toHaveBeenCalledOnce();
  } finally { await root.unmount(); }
});
