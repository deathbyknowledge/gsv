import { createRef, type ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import type { Distance } from "../Instrument";
import { InstrumentHeader } from "./InstrumentHeader";

async function headerButtons(distance: Distance) {
  const root = createTestRoot("Instrument header");
  let header: ComponentChildren;
  function Harness() {
    header = InstrumentHeader({
      distance, onNavigate: vi.fn(),
      helper: false, onShip: vi.fn(), help: false, onHelp: vi.fn(),
      helpButtonRef: createRef<HTMLButtonElement>(),
      navigationOpen: false, onNavigationToggle: vi.fn(),
      navigationButtonRef: createRef<HTMLButtonElement>(), navigationRef: createRef<HTMLElement>(),
    });
    return null;
  }
  try {
    await root.render(<Harness />);
  } finally {
    await root.unmount();
  }
  const nav = collectNodes(header).find((node) => node.type === "nav");
  expect(nav).toBeDefined();
  return collectNodes(nav).filter((node) => node.type === "button");
}

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("Instrument header", () => {
  it.each(["fleet", "memory", "people", "settings"] as const)(
    "keeps Search out of the top bar while %s is open",
    async (distance: Distance) => {
      const buttons = await headerButtons(distance);
      expect(buttons.map(collectText)).toEqual(["c chat", "f fleet", "m memory", "p people", "s settings", "? help"]);
    },
  );

  it("keeps Search out of the Chat top bar", async () => {
    expect((await headerButtons("zen")).map(collectText)).toEqual(["c chat", "f fleet", "m memory", "p people", "s settings", "? help"]);
  });

  it.each(["zen", "fleet", "memory", "people", "settings"] as const)(
    "keeps the shortcut badge separate from the %s label",
    async (distance: Distance) => {
      const buttons = await headerButtons(distance);
      const viewButtons = buttons.filter((button) => collectNodes(button).some((node) => node.props.class === "view-label"));
      expect(viewButtons).toHaveLength(5);
      expect(viewButtons.every((button) => collectNodes(button).some((node) => node.type === "kbd"))).toBe(true);
    },
  );
});
