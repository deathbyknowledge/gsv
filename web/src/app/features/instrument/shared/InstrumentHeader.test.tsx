import { createRef } from "preact";
import { describe, expect, it, vi } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import type { Distance } from "../Instrument";
import { InstrumentHeader } from "./InstrumentHeader";

describe("Instrument header search", () => {
  it.each(["zen", "fleet", "memory", "people", "settings"] as const)(
    "keeps Search beside Chat while %s is open",
    (distance: Distance) => {
      const onSearch = vi.fn();
      const header = InstrumentHeader({
        distance, onNavigate: vi.fn(), onSearch, searchEnabled: true,
        helper: false, onShip: vi.fn(), help: false, onHelp: vi.fn(),
        helpButtonRef: createRef<HTMLButtonElement>(),
      });
      const nav = collectNodes(header).find((node) => node.type === "nav");
      expect(nav).toBeDefined();
      const buttons = collectNodes(nav).filter((node) => node.type === "button");
      expect(buttons.slice(0, 2).map(collectText)).toEqual(["c chat", "Ctrl+K search"]);
      buttons[1].props.onClick?.();
      expect(onSearch).toHaveBeenCalledOnce();
    },
  );
});
