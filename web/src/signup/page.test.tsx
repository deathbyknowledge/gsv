import type { ComponentProps, VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contactInvitationUrl, encodeContactInvitation } from "@humansandmachines/gsv/protocol";
import { collectNodes, collectText } from "../app/testing/testHarness";
import type { WelcomeSnapshot, WelcomeState } from "../app/services/session/ownerWelcome";

import { loadSignupPage } from "./page";
import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";

const storage = { load: vi.fn<() => Promise<WelcomeSnapshot>>(), save: vi.fn<(revision: string, value: WelcomeState | null) => Promise<WelcomeSnapshot>>() };

const contact = encodeContactInvitation({ version: 2, did: "did:plc:sponsoraaaaaaaaaaaaaaaaa", handle: "sponsor.example",
  name: "Sponsor", token: "x".repeat(43), expiresAtMs: Date.now() + 60_000 });
const origin = "https://accounts.example.com";
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  storage.load.mockResolvedValue({ revision: "initial", value: null });
  storage.save.mockImplementation(async (_revision: string, value: WelcomeState | null): Promise<WelcomeSnapshot> => ({ revision: crypto.randomUUID(), value }));
  vi.stubGlobal("window", { location: { origin, search: "", href: contactInvitationUrl(contact, origin), assign },
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
  it.each([false, true])("opens signup or the shared welcome screen (welcome: %s)", async (welcome) => {
    window.location.href = `${origin}/owner/signup/`;
    window.location.search = welcome ? "?view=welcome" : "";
    const props = await screen();
    expect(props.initialStep).toBe(welcome ? "welcome" : "claim");
    expect(props.resume).toBe(!welcome);
    expect(props.homeHref).toBe("https://example.com/");
    expect((await props.load()).state.flow).toBe(welcome ? "open" : "create");
    if (welcome) expect(props.addressPanel).toBeTypeOf("function");
    else expect(props.addressPanel).toBeUndefined();
  });

  it.each([contact, encodeURIComponent(contact)])("accepts a legacy invitation fragment", async (value) => {
    window.location.href = `${origin}/#contact=${value}`;
    const props = await screen();
    expect(props.invitation).toMatchObject({ name: "Sponsor", handle: "sponsor.example" });
    await props.onConnect("https://custom.example.com");
    expectContactNavigation();
  });

  it("asks for a new invitation when the link is from before the update", async () => {
    const payload = btoa(JSON.stringify({ version: 1, origin: "https://sponsor.example" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    window.location.href = `${origin}/#contact=gsv-contact-v1:${payload}`;
    const page = await loadSignupPage(storage, origin);
    expect(collectText(page)).toContain("This invitation is from before an update. Ask for a new one.");
    expect(collectNodes(page).some((item) => item.type === OwnerWelcomeScreen)).toBe(false);
  });

  it("stores the canonical invitation code from a shared URL", async () => {
    const props = await screen();
    expect((await props.load()).state.contactInvite).toBe(contact);
    expect(sessionStorage.setItem).toHaveBeenCalledWith("gsv.contact-invitation", contact);
  });

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

describe("signup attribution", () => {
  it("keeps the website's placement and the campaign tags for the reservation and takes them off the URL", async () => {
    window.location.href = `${origin}/?utm_source=Facebook&utm_campaign=launch-nov&utm_content=photo#from=hero&example=plan-a-trip`;
    const props = await screen();
    expect((await props.load()).state.attribution).toEqual({ placement: "hero", example: "plan-a-trip", utmSource: "facebook", utmCampaign: "launch-nov" });
    // SAFETY: the page passes the URL object it rewrote as the third replaceState argument.
    const replaced = vi.mocked(window.history.replaceState).mock.lastCall![2] as URL;
    expect(replaced.hash).toBe("");
    expect(replaced.search).toBe("?utm_content=photo");
  });

  it("keeps a campaign tag from an ad link that never touched the website", async () => {
    window.location.href = `${origin}/?utm_source=facebook`;
    const props = await screen();
    expect((await props.load()).state.attribution).toEqual({ utmSource: "facebook" });
  });

  it("drops an origin left over from an abandoned attributed visit when signup starts again directly", async () => {
    window.location.href = origin;
    storage.load.mockResolvedValue({ revision: "saved", value: { origin, flow: "create", sessionSecret: null,
      challenge: null, operationId: null, handle: null, attribution: { placement: "hero" } } });
    const props = await screen();
    expect((await props.load()).state.attribution).toBeNull();
  });

  it("keeps the stored origin when a signup resumes without a fragment", async () => {
    window.location.href = `${origin}/?resume=1`;
    window.location.search = "?resume=1";
    storage.load.mockResolvedValue({ revision: "saved", value: { origin, flow: "create", sessionSecret: null,
      challenge: null, operationId: "op-1", handle: "resumed", attribution: { placement: "hero" } } });
    const props = await screen();
    expect((await props.load()).state.attribution).toEqual({ placement: "hero" });
  });

  it("ignores slugs that are not plain", async () => {
    window.location.href = `${origin}/?utm_source=face%20book&utm_campaign=${"x".repeat(33)}#from=Hero%20Banner&example=Plan%20A`;
    const props = await screen();
    expect((await props.load()).state.attribution).toBeNull();
  });
});
