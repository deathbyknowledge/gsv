import { describe, expect, it } from "vitest";
import { attentionTitle, createTabAttention } from "./tabAttention";

const ICON = { href: "https://gsv.test/favicon.svg", type: "image/svg+xml" };
const DOT = "data:image/png;base64,dot";

type Badge = { promise: Promise<string>; resolve: (href: string) => void; reject: (error: Error) => void };
/** The slice of `document` the tab attention reads and writes; the test flips visibility by hand. */
type FakeDocument = { title: string; visibilityState: DocumentVisibilityState; hasFocus: () => boolean };

function page() {
  let focused = false;
  const document: FakeDocument = { title: "GSV", visibilityState: "hidden", hasFocus: () => focused };
  const icon = { ...ICON };
  const badges: Badge[] = [];
  const attention = createTabAttention({
    document,
    icons: [icon],
    badge: () => {
      let resolve!: Badge["resolve"];
      let reject!: Badge["reject"];
      const promise = new Promise<string>((next, fail) => { resolve = next; reject = fail; });
      badges.push({ promise, resolve, reject });
      return promise;
    },
  });
  return {
    document, icon, badges, attention,
    show(focus = true) { document.visibilityState = "visible"; focused = focus; attention.viewed(); },
    hide() { document.visibilityState = "hidden"; focused = false; },
  };
}

/** Lets the badge promise's continuations run. */
const settled = () => new Promise<void>((next) => { setTimeout(next, 0); });

describe("tab attention", () => {
  it("prefixes the title with the count", () => {
    expect(attentionTitle("GSV", 0)).toBe("GSV");
    expect(attentionTitle("GSV", 3)).toBe("(3) GSV");
  });

  it("counts a committed message once, and only while the tab is out of view", () => {
    const tab = page();
    tab.show();
    tab.attention.arrived("m1");
    expect(tab.attention.count()).toBe(0);
    expect(tab.document.title).toBe("GSV");

    tab.hide();
    tab.attention.arrived("m2");
    expect(tab.document.title).toBe("(1) GSV");
    tab.attention.arrived("m3");
    tab.attention.arrived("m3");
    expect(tab.attention.count()).toBe(2);
    expect(tab.document.title).toBe("(2) GSV");
  });

  it("counts while the window lacks focus even when the document is visible", () => {
    const tab = page();
    tab.show(false);
    tab.attention.arrived("m1");
    expect(tab.attention.count()).toBe(1);
    tab.attention.viewed();
    expect(tab.attention.count()).toBe(1);
    tab.show();
    expect(tab.attention.count()).toBe(0);
  });

  it("badges the icon while messages wait and restores it when the tab is viewed", async () => {
    const tab = page();
    tab.attention.arrived("m1");
    expect(tab.badges).toHaveLength(1);
    tab.badges[0].resolve(DOT);
    await settled();
    expect(tab.icon).toEqual({ href: DOT, type: "image/png" });

    tab.attention.viewed();
    expect(tab.icon.href).toBe(DOT);

    tab.show();
    expect(tab.document.title).toBe("GSV");
    expect(tab.icon).toEqual(ICON);

    tab.hide();
    tab.attention.arrived("m2");
    expect(tab.badges).toHaveLength(1);
    expect(tab.icon).toEqual({ href: DOT, type: "image/png" });
  });

  it("leaves the icon alone when the badge resolves after the tab was viewed", async () => {
    const tab = page();
    tab.attention.arrived("m1");
    tab.show();
    tab.badges[0].resolve(DOT);
    await settled();
    expect(tab.icon).toEqual(ICON);
  });

  it("keeps the title count when the badge cannot be drawn", async () => {
    const tab = page();
    tab.attention.arrived("m1");
    tab.badges[0].reject(new Error("no image"));
    await settled();
    expect(tab.document.title).toBe("(1) GSV");
    expect(tab.icon).toEqual(ICON);
  });

  it("restores the page on dispose", () => {
    const tab = page();
    tab.attention.arrived("m1");
    tab.attention.dispose();
    expect(tab.document.title).toBe("GSV");
    expect(tab.attention.count()).toBe(0);
  });
});
