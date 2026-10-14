import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../../testing/testHarness";
import { useInstrumentViewport } from "./useInstrumentViewport";

async function screen(hasViewport = true) {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const browser = Object.assign(new EventTarget(), { visualViewport: hasViewport ? viewport : null, scrollY: 0 });
  const properties = new Map<string, string>();
  const element = { clientHeight: 844, style: {
    setProperty: (key: string, value: string) => { properties.set(key, value); },
    removeProperty: (key: string) => {
      const previous = properties.get(key) ?? "";
      properties.delete(key);
      return previous;
    },
  } };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", browser);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  function Harness() {
    const ref = useInstrumentViewport();
    // SAFETY: The hook only reads the root height and writes these CSS properties.
    ref.current = element as HTMLDivElement;
    return null;
  }
  const root = createTestRoot("instrument viewport");
  await root.render(<Harness />);
  return { viewport, browser, element, properties, frames, unmount: root.unmount,
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("instrument viewport", () => {
  it("keeps content inside the visible area as the keyboard opens, pans and closes", async () => {
    const view = await screen();
    try {
      expect(view.properties.get("--instrument-viewport-height")).toBe("844px");
      view.viewport.height = 480;
      view.viewport.dispatchEvent(new Event("resize"));
      view.viewport.offsetTop = 80;
      view.viewport.dispatchEvent(new Event("scroll"));
      expect(view.frames.size).toBe(1);
      view.flush();
      expect(view.properties.get("--instrument-viewport-top")).toBe("80px");
      expect(view.properties.get("--instrument-viewport-bottom")).toBe("284px");
      expect(view.properties.get("--instrument-viewport-height")).toBe("480px");

      view.viewport.height = 844;
      view.viewport.offsetTop = 0;
      view.viewport.dispatchEvent(new Event("resize"));
      view.flush();
      expect(view.properties.get("--instrument-viewport-top")).toBe("0px");
      expect(view.properties.get("--instrument-viewport-bottom")).toBe("0px");
      expect(view.properties.get("--instrument-viewport-height")).toBe("844px");
    } finally { await view.unmount(); }
  });

  it("updates after rotation without treating pinch zoom as a keyboard", async () => {
    const view = await screen();
    try {
      view.element.clientHeight = 390;
      view.viewport.height = 390;
      view.browser.dispatchEvent(new Event("resize"));
      view.flush();
      expect(view.properties.get("--instrument-viewport-height")).toBe("390px");

      view.viewport.scale = 2;
      view.viewport.height = 195;
      view.viewport.offsetTop = 100;
      view.viewport.dispatchEvent(new Event("resize"));
      view.flush();
      expect(view.properties.get("--instrument-viewport-height")).toBe("390px");
      expect(view.properties.get("--instrument-viewport-top")).toBe("0px");
      expect(view.properties.get("--instrument-viewport-bottom")).toBe("0px");

      view.viewport.scale = 1;
      view.viewport.height = 390;
      view.viewport.offsetTop = 0;
      view.viewport.dispatchEvent(new Event("resize"));
      view.flush();
      expect(view.properties.get("--instrument-viewport-height")).toBe("390px");
    } finally { await view.unmount(); }
  });

  it("keeps the background covering the viewport when iOS scrolls the document for the keyboard", async () => {
    const view = await screen();
    try {
      view.browser.scrollY = 403;
      view.browser.dispatchEvent(new Event("scroll"));
      view.viewport.height = 471;
      view.viewport.offsetTop = 341;
      view.viewport.dispatchEvent(new Event("scroll"));
      expect(view.frames.size).toBe(1);
      view.flush();
      expect(view.properties.get("--instrument-document-top")).toBe("403px");
      expect(view.properties.get("--instrument-viewport-top")).toBe("341px");
      expect(view.properties.get("--instrument-viewport-height")).toBe("471px");

      view.browser.scrollY = 40;
      view.browser.dispatchEvent(new Event("scroll"));
      view.viewport.offsetTop = 0;
      view.viewport.height = 844;
      view.viewport.dispatchEvent(new Event("resize"));
      view.flush();
      expect(view.properties.get("--instrument-document-top")).toBe("40px");
      expect(view.properties.get("--instrument-viewport-height")).toBe("844px");

      view.browser.scrollY = -12;
      view.browser.dispatchEvent(new Event("scroll"));
      view.flush();
      expect(view.properties.get("--instrument-document-top")).toBe("0px");
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
    view.viewport.dispatchEvent(new Event("resize"));
    expect(view.frames.size).toBe(1);
    await view.unmount();
    expect(view.frames.size).toBe(0);
    expect(view.properties.size).toBe(0);
    view.viewport.dispatchEvent(new Event("resize"));
    view.viewport.dispatchEvent(new Event("scroll"));
    view.browser.dispatchEvent(new Event("resize"));
    view.browser.dispatchEvent(new Event("scroll"));
    expect(view.frames.size).toBe(0);
  });
});
