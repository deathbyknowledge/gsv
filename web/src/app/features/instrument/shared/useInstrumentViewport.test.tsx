import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { useInstrumentViewport } from "./useInstrumentViewport";

class TestElement extends EventTarget {
  editable = false;
  matches() { return this.editable; }
}

async function screen(hasViewport = true, scale = 1) {
  const viewport = Object.assign(new EventTarget(), { height: 844, pageTop: 0, offsetTop: 0, scale });
  const motion = { matches: false };
  const browser = Object.assign(new EventTarget(), {
    visualViewport: hasViewport ? viewport : null, scrollY: 0, matchMedia: () => motion,
  });
  const properties = new Map<string, string>();
  const geometry = { top: 0, height: 844 };
  const events = new TestElement();
  const style: Partial<CSSStyleDeclaration> = {
    setProperty: (key: string, value: string) => { properties.set(key, value); },
    removeProperty: (key: string) => {
      const previous = properties.get(key) ?? "";
      properties.delete(key);
      return previous;
    },
  };
  const element: Partial<HTMLDivElement> = Object.assign(events, {
    getBoundingClientRect: () => ({
      x: 0, y: geometry.top, top: geometry.top, left: 0, right: 402,
      width: 402, height: geometry.height, bottom: geometry.top + geometry.height,
      toJSON: () => ({}),
    }),
    // SAFETY: The viewport owner only sets and removes its two custom properties.
    style: style as CSSStyleDeclaration,
  });
  const input = new TestElement();
  input.editable = true;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let now = 0;
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { maxTouchPoints: 0 });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  function Harness() {
    const ref = useInstrumentViewport();
    // SAFETY: This supplies the geometry, focus events and styles used by the hook.
    ref.current = element as HTMLDivElement;
    return null;
  }
  const root = createTestRoot("instrument viewport");
  await root.render(<Harness />);
  return { viewport, browser, geometry, motion, properties, frames, unmount: root.unmount,
    height: () => parseFloat(properties.get("--instrument-viewport-height") ?? "NaN"),
    top: () => parseFloat(properties.get("--instrument-viewport-top") ?? "NaN"),
    focus(type = "focusin", editable = true) {
      const event = new Event(type);
      Object.defineProperty(event, "target", { value: editable ? input : events });
      events.dispatchEvent(event);
    },
    flush(time = now + 16) {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("instrument viewport", () => {
  it("fits Safari's keyboard when the page starts at a retained zoom level", async () => {
    const view = await screen(true, 1.0159879922866821);
    try {
      view.viewport.height = 703;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.height()).toBe(703);
      view.focus();
      view.viewport.height = 371.0625;
      view.viewport.dispatchEvent(new Event("resize"));
      view.flush(200);
      expect(view.height()).toBe(371.0625);
      view.focus("focusout");
      view.viewport.height = 703;
      view.viewport.dispatchEvent(new Event("resize"));
      view.flush(400);
      expect(view.height()).toBe(703);
    } finally { await view.unmount(); }
  });

  it("uses the current zoom at a new input focus without resizing during a pinch", async () => {
    const view = await screen();
    try {
      view.viewport.scale = 1.6;
      view.viewport.height = 527.5;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.height()).toBe(844);
      view.focus();
      view.viewport.height = 260;
      view.viewport.dispatchEvent(new Event("resize"));
      view.flush(200);
      expect(view.height()).toBe(260);
    } finally { await view.unmount(); }
  });

  it("corrects viewport changes before the next frame, including nearly-unit Safari zoom", async () => {
    const view = await screen();
    try {
      expect(view.height()).toBe(844);
      view.viewport.height = 480;
      view.viewport.scale = 1.0041180849075317;
      view.viewport.pageTop = 80;
      view.viewport.offsetTop = 80;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.top()).toBe(80);
      expect(view.height()).toBe(480);
      expect(view.frames.size).toBe(0);

      view.viewport.height = 844;
      view.viewport.pageTop = 0;
      view.viewport.offsetTop = 0;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.top()).toBe(0);
      expect(view.height()).toBe(844);
    } finally { await view.unmount(); }
  });

  it("keeps the header anchored while a reported keyboard height animates the content", async () => {
    const view = await screen();
    try {
      view.focus();
      view.viewport.height = 480;
      view.viewport.pageTop = 364;
      view.viewport.offsetTop = 364;
      view.browser.scrollY = 364;
      view.geometry.top = -364;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.geometry.top + view.top()).toBe(0);
      expect(view.height()).toBe(844);
      view.flush(90);
      expect(view.height()).toBeGreaterThan(480);
      expect(view.height()).toBeLessThan(844);
      expect(view.geometry.top + view.top()).toBe(0);
      view.flush(200);
      expect(view.height()).toBe(480);
      view.flush(750);
      expect(view.frames.size).toBe(0);

      view.focus("focusout");
      view.viewport.height = 844;
      view.viewport.pageTop = 0;
      view.viewport.offsetTop = 0;
      view.browser.scrollY = 0;
      view.geometry.top = 0;
      view.browser.dispatchEvent(new Event("resize"));
      expect(view.top()).toBe(0);
      view.flush(950);
      expect(view.height()).toBe(844);
    } finally { await view.unmount(); }
  });

  it("detects delayed keyboard geometry even without another viewport event", async () => {
    const view = await screen();
    try {
      view.focus();
      view.flush(80);
      view.viewport.height = 480;
      view.flush(120);
      view.flush(320);
      expect(view.height()).toBe(480);
      view.flush(720);
      expect(view.frames.size).toBe(0);
      view.focus("focusin", false);
      expect(view.frames.size).toBe(0);
    } finally { await view.unmount(); }
  });

  it("follows incremental browser animation and respects reduced motion", async () => {
    const view = await screen();
    try {
      view.focus();
      for (const height of [804, 764, 724]) {
        view.viewport.height = height;
        view.viewport.dispatchEvent(new Event("resize"));
        expect(view.height()).toBe(height);
      }
      view.motion.matches = true;
      view.viewport.height = 480;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.height()).toBe(480);
    } finally { await view.unmount(); }
  });

  it("accounts for the root origin when Safari scrolls the window", async () => {
    const view = await screen();
    try {
      view.viewport.height = 480;
      view.viewport.pageTop = 364;
      view.browser.scrollY = 364;
      view.geometry.top = -364;
      view.browser.dispatchEvent(new Event("scroll"));
      expect(view.geometry.top + view.top()).toBe(0);
      expect(view.height()).toBe(480);
    } finally { await view.unmount(); }
  });

  it("uses the visible height before the background has resized", async () => {
    const view = await screen();
    try {
      view.viewport.height = 874;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.height()).toBe(874);
    } finally { await view.unmount(); }
  });

  it("updates after rotation without treating pinch zoom as a keyboard", async () => {
    const view = await screen();
    try {
      view.geometry.height = 390;
      view.viewport.height = 390;
      view.browser.dispatchEvent(new Event("resize"));
      expect(view.height()).toBe(390);

      view.viewport.scale = 2;
      view.viewport.height = 195;
      view.viewport.pageTop = 100;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.height()).toBe(390);
      expect(view.top()).toBe(0);

      view.viewport.scale = 1;
      view.viewport.height = 390;
      view.viewport.pageTop = 0;
      view.viewport.dispatchEvent(new Event("resize"));
      expect(view.height()).toBe(390);
    } finally { await view.unmount(); }
  });

  it("leaves CSS sizing in charge when the viewport API is unavailable", async () => {
    const view = await screen(false);
    try {
      view.browser.dispatchEvent(new Event("resize"));
      expect(view.properties.size).toBe(0);
      expect(view.frames.size).toBe(0);
    } finally { await view.unmount(); }
  });

  it("releases pending measurements and listeners when leaving the shell", async () => {
    const view = await screen();
    view.focus();
    expect(view.frames.size).toBe(1);
    await view.unmount();
    expect(view.frames.size).toBe(0);
    expect(view.properties.size).toBe(0);
    view.focus();
    view.viewport.dispatchEvent(new Event("resize"));
    view.viewport.dispatchEvent(new Event("scroll"));
    view.browser.dispatchEvent(new Event("resize"));
    view.browser.dispatchEvent(new Event("scroll"));
    expect(view.frames.size).toBe(0);
    expect(view.properties.size).toBe(0);
  });
});
