import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { useDismissOnOutsideClick } from "./useDismissOnOutsideClick";

type PointerListener = (event: PointerEvent) => void;

/** A node that contains itself and the given descendants, which is all the hook asks of an element. */
function element(...descendants: object[]): Element {
  const node = { contains: (other: Node | null) => other === node || descendants.includes(other as object) };
  // SAFETY: the hook only calls contains; the harness renders no DOM.
  return node as unknown as Element;
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

async function press(listeners: Set<PointerListener>, target: object): Promise<void> {
  await act(() => { for (const listener of [...listeners]) listener({ target } as unknown as PointerEvent); });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useDismissOnOutsideClick", () => {
  it("closes on a press outside the popover and its trigger, and listens only while open", async () => {
    const listeners = fakeDocument();
    const option = {};
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
    await press(listeners, {});
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await root.unmount();
  });
});
