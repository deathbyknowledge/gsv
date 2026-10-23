import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { collectNodes, createTestRoot, collectText } from "../../../testing/testHarness";
import type { Distance } from "../Instrument";
import { HelpContent } from "./HelpContent";

afterEach(() => vi.unstubAllGlobals());

it.each(["MacIntel", "Win32"])("keeps onboarding destinations and shortcuts relevant to the current screen on %s", async (platform) => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { platform });
  const root = createTestRoot("Help");
  const onNavigate = vi.fn();
  const onSearch = vi.fn();
  const onFeedback = vi.fn();
  let tree: ComponentChildren;
  function Harness({ distance = "zen" }: { distance?: Distance }) {
    tree = HelpContent({ distance, connected: true, onClose: vi.fn(), onNavigate, onSearch, onFeedback });
    return null;
  }
  try {
    await root.render(<Harness />);
    const nodes = collectNodes(tree);
    // SAFETY: Help's keyboard boundary only reads key and stops propagation; native activation remains enabled.
    const content = nodes.find((node) => node.props.class === "instrument-help-content") as VNode<{ onKeyDown?: (event: Pick<KeyboardEvent, "key" | "stopPropagation" | "preventDefault">) => void }>;
    for (const key of [" ", "Enter", "Tab", "Escape", "s"]) {
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();
      await act(() => content.props.onKeyDown?.({ key, stopPropagation, preventDefault }));
      expect(stopPropagation).toHaveBeenCalledTimes(key === " " || key === "Enter" ? 1 : 0);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    const links = nodes.filter((node) => node.type === "a");
    const hrefs = links.map((node) => node.props.href);
    expect(hrefs).toEqual(expect.arrayContaining([
      "/chat/settings?section=messengers", "/memory", "/chat/settings?section=permissions",
      "https://ship.space/privacy", "mailto:hello@humansandmachin.es", "https://discord.gg/hy9ExJJFvn",
    ]));
    expect(hrefs.some((href) => href?.includes("gsv-manual") && href.startsWith("/memory"))).toBe(true);
    const disclosures = nodes.filter((node) => node.type === "details");
    expect(disclosures).toHaveLength(1);
    // SAFETY: The filtered nodes are native details elements; open is their disclosure state.
    const details = disclosures as VNode<{ open?: boolean }>[];
    expect(details.every((node) => !node.props.open)).toBe(true);
    expect(nodes.filter((node) => node.type === "summary")).toHaveLength(1);
    const text = collectText(tree);
    for (const label of ["What can Ship help with?", "Getting started", "Memory", "Keyboard shortcuts", "Need more help?"]) expect(text).toContain(label);
    expect(text).not.toContain("Search Chat");
    expect(text).not.toContain("Chat · browse");
    expect(text).not.toContain("Your information is yours");
    // SAFETY: The native link handler reads only these event fields and the href.
    const link = links.find((node) => node.props.href === "/chat/settings?section=permissions") as VNode<{ href: string; onClick?: (event: { button: number; defaultPrevented: boolean; preventDefault: () => void; metaKey?: boolean; currentTarget: { getAttribute: () => string } }) => void }>;
    const preventDefault = vi.fn();
    const event = { button: 0, defaultPrevented: false, preventDefault, currentTarget: { getAttribute: () => link.props.href } };
    await act(() => link.props.onClick?.(event));
    expect(onNavigate).toHaveBeenCalledWith("/chat/settings?section=permissions");
    expect(preventDefault).toHaveBeenCalledOnce();
    onNavigate.mockClear();
    await act(() => link.props.onClick?.({ ...event, metaKey: true }));
    expect(onNavigate).not.toHaveBeenCalled();
    const feedback = nodes.find((node) => node.type === "button" && node.props.class === "instrument-help-feedback");
    expect(collectText(feedback)).toBe("Feedback");
    await act(() => feedback?.props.onClick?.());
    expect(onFeedback).toHaveBeenCalledOnce();
    const shortcutsButton = nodes.find((node) => node.type === "button" && node.props.class === "instrument-help-shortcuts");
    await act(() => shortcutsButton?.props.onClick?.());
    const shortcutNodes = collectNodes(tree);
    const shortcutText = collectText(tree);
    for (const label of ["Chat · browse", "Chat · input", "Keyboard shortcuts", "Search Chat"]) expect(shortcutText).toContain(label);
    expect(shortcutText).not.toContain("What can Ship help with?");
    expect(shortcutText).not.toContain("Getting started");
    expect(shortcutText).not.toContain("Need more help?");
    expect(shortcutNodes.some((node) => node.type === "details")).toBe(false);
    expect(shortcutText).toContain(platform === "MacIntel" ? "⌘ F" : "Ctrl + F");
    const sections = [
      { distance: "zen", headings: ["Chat · browse", "Chat · input"] },
      { distance: "memory", headings: ["Memory"] },
      { distance: "fleet", headings: ["Work", "Expanded file"] },
      { distance: "people", headings: ["Contact messages"] },
      { distance: "settings", headings: ["Settings"] },
    ] satisfies { distance: Distance; headings: string[] }[];
    for (const { distance, headings: expectedHeadings } of sections) {
      await root.render(<Harness distance={distance} />);
      const headings = collectNodes(tree).filter((node) => node.type === "h4").map((node) => collectText(node));
      expect(headings).toEqual(["Views & appearance", ...expectedHeadings]);
      expect(collectText(tree)).toContain("Search Chat");
      if (distance === "memory" || distance === "fleet") expect(collectText(tree)).toContain(platform === "MacIntel" ? "⌘ Enter" : "Ctrl + Enter");
    }
    const search = collectNodes(tree).find((node) => node.type === "button" && node.props.class === "instrument-help-search");
    await act(() => search?.props.onClick?.());
    expect(onSearch).toHaveBeenCalledOnce();
    const back = collectNodes(tree).find((node) => node.type === "button" && node.props.class === "instrument-help-back");
    await act(() => back?.props.onClick?.());
    expect(collectText(tree)).toContain("Getting started");
    expect(collectText(tree)).not.toContain("Search Chat");
  } finally { await root.unmount(); }
});
