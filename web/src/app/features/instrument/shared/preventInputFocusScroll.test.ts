import { afterEach, describe, expect, it, vi } from "vitest";
import { preventInputFocusScroll } from "./preventInputFocusScroll";

class Input extends EventTarget {
  editable = true;
  focus = vi.fn();
  matches() { return this.editable; }
}

class TestDocument {
  activeElement: Input | null = null;
}

function screen({ touch = true, webkit = true } = {}) {
  const root: Partial<HTMLElement> = new EventTarget();
  const input = new Input();
  const document = new TestDocument();
  let now = 0;
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { maxTouchPoints: touch ? 5 : 0 });
  vi.stubGlobal("CSS", { supports: () => webkit });
  vi.stubGlobal("HTMLElement", Input);
  vi.stubGlobal("performance", { now: () => now });
  // SAFETY: This focus guard only subscribes to events on its shell root.
  const stop = preventInputFocusScroll(root as HTMLElement);
  return { input, document, stop, advance: (time: number) => { now += time; },
    touch(type: string, { x = 0, y = 0, count = type === "touchend" ? 0 : 1, prevented = false } = {}) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperties(event, {
        target: { value: input },
        touches: { value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) },
      });
      if (prevented) event.preventDefault();
      root.dispatchEvent?.(event);
      return event;
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("touch keyboard focus", () => {
  it("focuses the first tap without the browser's automatic page scroll", () => {
    const view = screen();
    view.touch("touchstart");
    const event = view.touch("touchend");
    expect(event.defaultPrevented).toBe(true);
    expect(view.input.focus).toHaveBeenCalledWith({ preventScroll: true });
    view.stop();
  });

  it("preserves caret placement and native menus in an already focused input", () => {
    const view = screen();
    view.document.activeElement = view.input;
    view.touch("touchstart");
    expect(view.touch("touchend").defaultPrevented).toBe(false);
    expect(view.input.focus).not.toHaveBeenCalled();
    view.stop();
  });

  it("leaves long presses, dragging, pinch and cancelled gestures alone", () => {
    const view = screen();
    view.touch("touchstart");
    view.advance(600);
    expect(view.touch("touchend").defaultPrevented).toBe(false);
    view.touch("touchstart");
    view.touch("touchmove", { y: 20 });
    expect(view.touch("touchend").defaultPrevented).toBe(false);
    view.touch("touchstart", { count: 2 });
    expect(view.touch("touchend").defaultPrevented).toBe(false);
    view.touch("touchstart");
    view.touch("touchcancel");
    expect(view.touch("touchend").defaultPrevented).toBe(false);
    view.touch("touchstart");
    view.touch("touchend", { prevented: true });
    expect(view.input.focus).not.toHaveBeenCalled();
    view.stop();
  });

  it("does not take focus from non-text controls or unsupported browsers", () => {
    const view = screen();
    view.input.editable = false;
    view.touch("touchstart");
    expect(view.touch("touchend").defaultPrevented).toBe(false);
    expect(view.input.focus).not.toHaveBeenCalled();
    view.stop();
    for (const options of [{ touch: false }, { webkit: false }]) {
      const other = screen(options);
      other.touch("touchstart");
      expect(other.touch("touchend").defaultPrevented).toBe(false);
      expect(other.input.focus).not.toHaveBeenCalled();
      other.stop();
    }
  });

  it("releases its listeners when the shell leaves", () => {
    const view = screen();
    view.touch("touchstart");
    view.stop();
    expect(view.touch("touchend").defaultPrevented).toBe(false);
    expect(view.input.focus).not.toHaveBeenCalled();
  });
});
