import type { ComponentProps, VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeContactInvitation } from "@humansandmachines/gsv/protocol";
import { collectNodes } from "../app/testing/testHarness";
import type { WelcomeSnapshot, WelcomeState } from "../app/services/session/ownerWelcome";

import { loadSignupPage } from "./page";
import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";

const storage = { load: vi.fn<() => Promise<WelcomeSnapshot>>(), save: vi.fn<(revision: string, value: WelcomeState | null) => Promise<WelcomeSnapshot>>() };

const contact = encodeContactInvitation({ version: 1, origin: "https://sponsor.example", shipId: "ship:sponsor",
  subject: { id: "subject:sponsor", displayName: "Sponsor" }, token: "x".repeat(43), expiresAtMs: Date.now() + 60_000 });
const origin = "https://accounts.example.com";
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  storage.load.mockResolvedValue({ revision: "initial", value: null });
  storage.save.mockImplementation(async (_revision: string, value: WelcomeState | null): Promise<WelcomeSnapshot> => ({ revision: crypto.randomUUID(), value }));
  vi.stubGlobal("window", { location: { origin, search: "", href: `${origin}/#contact=${encodeURIComponent(contact)}`, assign },
    history: { replaceState: vi.fn() } });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function screen() {
  const page = await loadSignupPage(storage, origin);
  const node = collectNodes(page).find((item) => item.type === OwnerWelcomeScreen);
  if (!node) throw new Error("Expected owner welcome recovery screen");
  // SAFETY: The component identity above determines the props of this captured render.
  return (node as VNode<ComponentProps<typeof OwnerWelcomeScreen>>).props;
}

function expectContactNavigation() {
  const destination = new URL(assign.mock.lastCall![0]);
  expect(destination.origin).toBe("https://custom.example.com");
  expect(new URLSearchParams(destination.hash.slice(1)).get("contact")).toBe(contact);
}

describe("signup entrypoint recovery", () => {
  it.each(["load", "save"] as const)("opens an existing space when signup storage cannot %s", async (operation) => {
    const failure = new Error("Storage unavailable");
    storage[operation].mockRejectedValue(failure);
    const props = await screen();
    expect(props.invitation?.name).toBe("Sponsor");
    expect(props.addressPanel).toBeTypeOf("function");
    await expect(props.load()).rejects.toBe(failure);
    await props.onConnect("https://custom.example.com");
    expectContactNavigation();
  });

  it("keeps an invitation restored from disk when another tab changed signup", async () => {
    window.location.href = origin;
    storage.load.mockResolvedValue({ revision: "saved", value: { origin, flow: "create", sessionSecret: null,
      challenge: null, operationId: "existing-operation", handle: null, contactInvite: contact } });
    storage.save.mockRejectedValue(new Error("Signup changed in another tab"));
    const props = await screen();
    await expect(props.load()).rejects.toThrow("Signup changed");
    await props.onConnect("https://custom.example.com");
    expectContactNavigation();
  });

  it("still navigates if clearing signup state fails after the screen loaded", async () => {
    const props = await screen();
    await expect(props.load()).resolves.toBeDefined();
    storage.save.mockRejectedValue(new Error("Signup changed in another tab"));
    await expect(props.onConnect("https://custom.example.com")).rejects.toThrow("Signup changed");
    expectContactNavigation();
  });
});
