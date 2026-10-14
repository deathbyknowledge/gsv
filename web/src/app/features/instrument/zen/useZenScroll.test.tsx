import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { useZenScroll } from "./useZenScroll";

class Row {
  dataset: { momentId: string };
  constructor(id: string, public offsetTop: number, public offsetHeight = 160) {
    this.dataset = { momentId: id };
  }
  closest() { return this; }
}

async function transcript(promptFocused = false) {
  const rows = Array.from({ length: 6 }, (_, index) => new Row(`message-${index}`, index * 200 + 20));
  const moments = rows.map((row) => ({ id: row.dataset.momentId }));
  const listeners = new Map<string, Set<EventListener>>();
  let top = 0;
  let resize = () => {};
  const viewport = {
    scrollHeight: 1220, clientHeight: 300,
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) { listeners.get(type)?.delete(listener); },
  };
  const content: Partial<HTMLDivElement> = { querySelectorAll: vi.fn().mockReturnValue(rows) };
  vi.stubGlobal("document", {});
  vi.stubGlobal("Element", Row);
  vi.stubGlobal("getComputedStyle", () => ({ scrollPaddingTop: "12px" }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  let scrolling!: ReturnType<typeof useZenScroll>;
  function Harness({ focused }: { focused: boolean }) {
    scrolling = useZenScroll({ moments, ready: true, promptFocused: focused,
      hasOlder: false, loadingOlder: false, loadOlder: async () => {} });
    // SAFETY: The hook uses only the geometry and event methods supplied by this viewport fixture.
    scrolling.viewport.current = viewport as HTMLDivElement;
    // SAFETY: The content fixture supplies the hook's only body operation, querying transcript rows.
    scrolling.content.current = content as HTMLDivElement;
    return null;
  }
  const root = createTestRoot("transcript selection");
  await root.render(<Harness focused={promptFocused} />);
  const emit = async (type: string, target?: Row) => {
    await act(() => {
      const event = new Event(type);
      if (target) Object.defineProperty(event, "target", { value: target });
      for (const listener of listeners.get(type) ?? []) listener(event);
    });
  };
  return { rows, viewport, emit, state: () => scrolling, unmount: root.unmount,
    focus: () => root.render(<Harness focused />),
    resize: () => act(() => resize()),
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("transcript selection", () => {
  it("selects a clicked message without moving it, then continues keyboard navigation from there", async () => {
    const chat = await transcript();
    try {
      const top = chat.viewport.scrollTop;
      await chat.emit("click", chat.rows[4]);
      expect(chat.state().selection).toBe(4);
      expect(chat.state().browse).toBe(4);
      expect(chat.viewport.scrollTop).toBe(top);
      await act(() => chat.state().select(chat.state().browse! - 1));
      expect(chat.state().selection).toBe(3);
      expect(chat.viewport.scrollTop).toBe(chat.rows[3].offsetTop - 12);
    } finally { await chat.unmount(); }
  });

  it("shows the message being read while scrolling with the composer focused", async () => {
    const chat = await transcript(true);
    try {
      chat.viewport.scrollTop = 220;
      await chat.emit("scroll");
      expect(chat.state().selection).toBe(1);
      expect(chat.state().browse).toBeNull();
      expect(chat.state().awayFromBottom).toBe(true);
      chat.viewport.scrollTop = chat.viewport.scrollHeight;
      await chat.emit("scroll");
      expect(chat.state().selection).toBe(5);
      expect(chat.state().awayFromBottom).toBe(false);
    } finally { await chat.unmount(); }
  });

  it("keeps pointer selection and reading position through focus and content resizing", async () => {
    const chat = await transcript();
    try {
      await chat.emit("click", chat.rows[4]);
      await chat.focus();
      expect(chat.state().selection).toBe(4);
      expect(chat.state().browse).toBeNull();
      const offset = chat.rows[4].offsetTop - chat.viewport.scrollTop;
      for (const row of chat.rows.slice(3)) row.offsetTop += 100;
      chat.viewport.scrollHeight += 100;
      await chat.resize();
      await chat.emit("scroll");
      expect(chat.rows[4].offsetTop - chat.viewport.scrollTop).toBe(offset);
      expect(chat.state().selection).toBe(4);
    } finally { await chat.unmount(); }
  });

  it("updates the same selection when native gestures scroll and when returning to the latest message", async () => {
    const chat = await transcript(true);
    try {
      await act(() => chat.state().move(-450));
      expect(chat.state().selection).toBe(2);
      expect(chat.state().awayFromBottom).toBe(true);
      await act(() => chat.state().follow());
      expect(chat.state().selection).toBe(5);
      expect(chat.state().awayFromBottom).toBe(false);
    } finally { await chat.unmount(); }
  });
});
