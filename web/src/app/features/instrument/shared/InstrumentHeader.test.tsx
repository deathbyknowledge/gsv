import { createRef } from "preact";
import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import type { Distance } from "../Instrument";
import { InstrumentHeader } from "./InstrumentHeader";

function headerButtons(distance: Distance, onSearch = vi.fn()) {
  const header = InstrumentHeader({
    distance, onNavigate: vi.fn(), onSearch, searchEnabled: true,
    helper: false, onShip: vi.fn(), help: false, onHelp: vi.fn(),
    helpButtonRef: createRef<HTMLButtonElement>(),
  });
  const nav = collectNodes(header).find((node) => node.type === "nav");
  expect(nav).toBeDefined();
  return collectNodes(nav).filter((node) => node.type === "button");
}

describe("Instrument header search", () => {
  it("shows Search immediately before Chat in Chat", () => {
    const onSearch = vi.fn();
    const buttons = headerButtons("zen", onSearch);
    expect(buttons.slice(0, 2).map(collectText)).toEqual(["Ctrl+K search", "c chat"]);
    buttons[0].props.onClick?.();
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it.each(["fleet", "memory", "people", "settings"] as const)(
    "hides Search while %s is open",
    (distance: Distance) => {
      const buttons = headerButtons(distance);
      expect(buttons.map(collectText)).toEqual(["c chat", "f fleet", "m memory", "p people", "s settings", "? keys"]);
    },
  );

  it.each(["zen", "fleet", "memory", "people", "settings"] as const)(
    "keeps the shortcut badge separate from the %s label",
    (distance: Distance) => {
      const buttons = headerButtons(distance);
      const viewButtons = buttons.filter((button) => collectNodes(button).some((node) => node.props.class === "view-label"));
      expect(viewButtons).toHaveLength(5);
      expect(viewButtons.every((button) => collectNodes(button).some((node) => node.type === "kbd"))).toBe(true);
    },
  );
});
