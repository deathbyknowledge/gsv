import { createRef, type ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import type { Distance } from "../Instrument";
import { InstrumentHeader } from "./InstrumentHeader";
import { LineIcon } from "./lineIcons";

async function headerButtons(distance: Distance, peopleWaiting = false) {
  const root = createTestRoot("Instrument header");
  let header: ComponentChildren;
  function Harness() {
    header = InstrumentHeader({
      distance, onNavigate: vi.fn(), peopleWaiting,
      helper: false, onShip: vi.fn(), help: false, onHelp: vi.fn(),
      helpButtonRef: createRef<HTMLButtonElement>(),
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
  it.each(["zen", "fleet", "memory", "people", "settings"] as const)("names every view with an icon and an Alt shortcut while %s is open", async (distance: Distance) => {
    const buttons = await headerButtons(distance);
    expect(buttons.map(collectText)).toEqual(["chat", "work", "memory", "people", "settings", "help"]);
    expect(buttons.map((button) => button.props["aria-keyshortcuts"])).toEqual(["Alt+C", "Alt+W", "Alt+M", "Alt+P", "Alt+S", "Alt+H"]);
    expect(buttons.every((button) => collectNodes(button).some((node) => node.type === LineIcon))).toBe(true);
    expect(buttons.some((button) => collectNodes(button).some((node) => node.type === "kbd"))).toBe(false);
  });

  it("marks only the open view as the current page", async () => {
    const buttons = await headerButtons("memory");
    expect(buttons.map((button) => button.props["aria-current"])).toEqual([undefined, undefined, "page", undefined, undefined, undefined]);
  });

  it("dots People while someone is waiting there, except when People is open", async () => {
    expect(collectText((await headerButtons("zen", true))[3])).toBe("people •");
    expect(collectText((await headerButtons("people", true))[3])).toBe("people");
  });
});
