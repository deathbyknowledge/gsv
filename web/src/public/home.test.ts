import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORAGE_SESSION_TOKEN } from "../app/services/session/sessionService";

const SCRIPT = readFileSync(new URL("../../public/social/home.js", import.meta.url), "utf8");

class Anchor { href = "/chat"; }

type StoredSession = { username: string; tokenId: string; token: string; expiresAt: number | null };

/** Runs the profile page's head script at `address`, with `stored` as this browser's stored session text. */
function visit(address: string, stored: string | null) {
  const url = new URL(address);
  const replace = vi.fn();
  const listeners: Array<() => void> = [];
  const link = new Anchor();
  vi.stubGlobal("location", { pathname: url.pathname, search: url.search, hash: url.hash, replace });
  vi.stubGlobal("localStorage", { getItem: (key: string) => (key === STORAGE_SESSION_TOKEN ? stored : null) });
  vi.stubGlobal("HTMLAnchorElement", Anchor);
  vi.stubGlobal("document", {
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    querySelector: (selector: string) => (selector === ".sign-in a" ? link : null),
  });
  new Function(SCRIPT)();
  for (const listener of listeners) listener();
  return { replace, link };
}

function session(expiresAt: number | null): string {
  const stored: StoredSession = { username: "person", tokenId: "t", token: "secret", expiresAt };
  return JSON.stringify(stored);
}

describe("the Ship's address", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes a browser signed in to the Ship to the app, keeping what the address carried", () => {
    const { replace } = visit("https://person.ship.example/?browserInstance=one&browserHandoff=two#top", session(null));
    expect(replace).toHaveBeenCalledWith("/chat?browserInstance=one&browserHandoff=two#top");
  });

  it("shows everyone else the profile, with a sign-in link that keeps the address's query", () => {
    for (const stored of [null, session(Date.now() - 1), "{\"nonsense\":true}", "not json"]) {
      const { replace, link } = visit("https://person.ship.example/?browserInstance=one", stored);
      expect(replace).not.toHaveBeenCalled();
      expect(link.href).toBe("/chat?browserInstance=one");
    }
  });

  it("always shows the page at /profile, so owners can see it as visitors do", () => {
    const { replace, link } = visit("https://person.ship.example/profile", session(null));
    expect(replace).not.toHaveBeenCalled();
    expect(link.href).toBe("/chat");
  });
});
