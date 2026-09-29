import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { useDismissOnOutsideClick } from "./useDismissOnOutsideClick";

type PointerListener = (event: PointerEvent) => void;

/** What the hook asks of an element: whether it contains the pressed node. */
type Containing = { contains: (other: Node | null) => boolean };

/** A node that contains itself and the given descendants. */
function element(...descendants: Element[]): Element {
  const node: Containing = { contains: (other) => other === node || descendants.some((descendant) => descendant === other) };
  // SAFETY: the hook only calls contains on the elements it is handed; the harness renders no DOM.
  return node as Element;
}

function fakeDocument(): Set<PointerListener> {
  const listeners = new Set<PointerListener>();
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: PointerListener, capture: boolean) => {
      expect(type).toBe("pointerdown");
      expect(capture).toBe(true);
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: PointerListener) => { listeners.delete(listener); },
  });
  return listeners;
}

async function press(listeners: Set<PointerListener>, target: Element): Promise<void> {
  const event: Pick<PointerEvent, "target"> = { target };
  await act(() => {
    for (const listener of listeners) {
      // SAFETY: the hook reads only event.target; the harness dispatches no real pointer events.
      listener(event as PointerEvent);
    }
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useDismissOnOutsideClick", () => {
  it("closes on a press outside the popover and its trigger, and listens only while open", async () => {
    const listeners = fakeDocument();
    const option = element();
    const menu = element(option);
    const trigger = element();
    const elsewhere = element();
    const dismiss = vi.fn();
    function Harness({ open }: { open: boolean }) {
      useDismissOnOutsideClick(open, () => [menu, trigger, null], dismiss);
      return null;
    }
    const root = createTestRoot("useDismissOnOutsideClick");
    await root.render(<Harness open={false} />);
    expect(listeners.size).toBe(0);
    await root.render(<Harness open />);
    expect(listeners.size).toBe(1);
    await press(listeners, option);
    await press(listeners, trigger);
    expect(dismiss).not.toHaveBeenCalled();
    await press(listeners, elsewhere);
    expect(dismiss).toHaveBeenCalledTimes(1);
    await root.render(<Harness open={false} />);
    expect(listeners.size).toBe(0);
    await root.render(<Harness open />);
    expect(listeners.size).toBe(1);
    await root.unmount();
    expect(listeners.size).toBe(0);
  });

  it("keeps one listener across re-renders and calls the latest dismiss", async () => {
    const listeners = fakeDocument();
    const first = vi.fn();
    const second = vi.fn();
    function Harness({ dismiss }: { dismiss: () => void }) {
      useDismissOnOutsideClick(true, () => [], dismiss);
      return null;
    }
    const root = createTestRoot("useDismissOnOutsideClick");
    await root.render(<Harness dismiss={first} />);
    const [listener] = [...listeners];
    await root.render(<Harness dismiss={second} />);
    expect([...listeners]).toEqual([listener]);
    await press(listeners, element());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await root.unmount();
  });
});
