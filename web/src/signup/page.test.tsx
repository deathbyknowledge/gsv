import type { ComponentProps, VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes } from "../app/testing/testHarness";
import type { WelcomeSnapshot, WelcomeState } from "../app/services/session/ownerWelcome";

import { loadSignupPage } from "./page";
import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";

const storage = { load: vi.fn<() => Promise<WelcomeSnapshot>>(), save: vi.fn<(revision: string, value: WelcomeState | null) => Promise<WelcomeSnapshot>>() };

const origin = "https://accounts.example.com";
/** Someone's invitation link, naming their Ship elsewhere by its address. */
const invitation = `${origin}/owner/signup/?invite=sponsor.example`;
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  storage.load.mockResolvedValue({ revision: "initial", value: null });
  storage.save.mockImplementation(async (_revision: string, value: WelcomeState | null): Promise<WelcomeSnapshot> => ({ revision: crypto.randomUUID(), value }));
  vi.stubGlobal("window", { location: { origin, search: "", href: invitation, assign },
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

/** An existing Ship opens a request to the inviter's profile, as that profile's own page would. */
function expectInviteNavigation(profile = "https://sponsor.example/profile") {
  const destination = new URL(assign.mock.lastCall![0]);
  expect(destination.origin).toBe("https://custom.example.com");
  expect(destination.pathname).toBe("/people");
  expect(destination.searchParams.get("compose")).toBe(profile);
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

  it("names the inviter and opens a request to them from an existing Ship", async () => {
    const props = await screen();
    expect(props.invitation).toEqual({ name: "sponsor.example" });
    expect(props.chooseSpace).toBe(true);
    expect(props.initialStep).toBe("email");
    await props.onConnect("https://custom.example.com");
    expectInviteNavigation();
  });

  it("reads a bare handle as a Ship on the operator's domain", async () => {
    window.location.href = `${origin}/owner/signup/?invite=Esteve`;
    const props = await screen();
    expect(props.invitation).toEqual({ name: "@esteve" });
    await props.onConnect("https://custom.example.com");
    expectInviteNavigation("https://esteve.example.com/profile");
  });

  it("carries the inviter's profile into a new Ship's setup", async () => {
    const token = `onboard_${"x".repeat(43)}`;
    const props = await screen();
    await props.onConnect("https://nora.example.com", token);
    const destination = new URL(assign.mock.lastCall![0]);
    expect(destination.pathname).toBe("/onboarding");
    expect(Object.fromEntries(new URLSearchParams(destination.hash.slice(1)))).toEqual({ onboarding: token, invite: "https://sponsor.example/profile" });
  });

  it("opens plain signup for an old single-use invitation or an unusable name", async () => {
    for (const href of [`${origin}/connect#contact=gsv-contact-v2:abc`, `${origin}/owner/signup/?invite=%3Cscript%3E`]) {
      window.location.href = href;
      const props = await screen();
      expect(props.invitation).toBeUndefined();
      expect(props.chooseSpace).toBe(false);
    }
  });

  it("keeps the invitation through a reload and takes it off the address", async () => {
    const props = await screen();
    expect((await props.load()).state.invite).toBe("sponsor.example");
    // SAFETY: the page passes the URL object it rewrote as the third replaceState argument.
    const replaced = vi.mocked(window.history.replaceState).mock.lastCall![2] as URL;
    expect(replaced.searchParams.has("invite")).toBe(false);
  });

  it.each(["load", "save"] as const)("opens an existing space when signup storage cannot %s", async (operation) => {
    const failure = new Error("Storage unavailable");
    storage[operation].mockRejectedValue(failure);
    const props = await screen();
    expect(props.invitation?.name).toBe("sponsor.example");
    expect(props.addressPanel).toBeTypeOf("function");
    await expect(props.load()).rejects.toBe(failure);
    await props.onConnect("https://custom.example.com");
    expectInviteNavigation();
  });

  it("keeps an invitation restored from disk when another tab changed signup", async () => {
    window.location.href = origin;
    storage.load.mockResolvedValue({ revision: "saved", value: { origin, flow: "create", sessionSecret: null,
      challenge: null, operationId: "existing-operation", handle: null, invite: "sponsor.example" } });
    storage.save.mockRejectedValue(new Error("Signup changed in another tab"));
    const props = await screen();
    await expect(props.load()).rejects.toThrow("Signup changed");
    await props.onConnect("https://custom.example.com");
    expectInviteNavigation();
  });

  it("still navigates if clearing signup state fails after the screen loaded", async () => {
    const props = await screen();
    await expect(props.load()).resolves.toBeDefined();
    storage.save.mockRejectedValue(new Error("Signup changed in another tab"));
    await expect(props.onConnect("https://custom.example.com")).rejects.toThrow("Signup changed");
    expectInviteNavigation();
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

  it("keeps the stored origin when the page loads again without one, as a reload or a restored tab does", async () => {
    window.location.href = `${origin}/owner/signup/`;
    storage.load.mockResolvedValue({ revision: "saved", value: { origin, flow: "create", sessionSecret: null,
      challenge: { id: "challenge-1", email: "ada@example.com", browserSecret: "a".repeat(64) }, operationId: null, handle: null,
      attribution: { placement: "hero", utmSource: "facebook" } } });
    const props = await screen();
    expect((await props.load()).state.attribution).toEqual({ placement: "hero", utmSource: "facebook" });
  });

  it("replaces the stored origin with a new link's own", async () => {
    window.location.href = `${origin}/?utm_source=linkedin`;
    storage.load.mockResolvedValue({ revision: "saved", value: { origin, flow: "create", sessionSecret: null,
      challenge: null, operationId: null, handle: null, attribution: { placement: "hero" } } });
    const props = await screen();
    expect((await props.load()).state.attribution).toEqual({ utmSource: "linkedin" });
  });

  it("keeps the stored origin when a signup resumes without a fragment", async () => {
    window.location.href = `${origin}/?resume=1`;
    window.location.search = "?resume=1";
    storage.load.mockResolvedValue({ revision: "saved", value: { origin, flow: "create", sessionSecret: null,
      challenge: null, operationId: "op-1", handle: "resumed", attribution: { placement: "hero" } } });
    const props = await screen();
    expect((await props.load()).state.attribution).toEqual({ placement: "hero" });
  });

  it("sends someone a messenger sent here to their new Ship with that messenger's connection to open", async () => {
    const token = `onboard_${"x".repeat(43)}`;
    window.location.href = `${origin}/?utm_source=whatsapp`;
    const props = await screen();
    expect((await props.load()).state.attribution).toEqual({ utmSource: "whatsapp" });
    await props.onConnect("https://nora.gsv.space", token);
    const destination = new URL(assign.mock.lastCall![0]);
    expect(destination.pathname).toBe("/onboarding");
    expect(Object.fromEntries(new URLSearchParams(destination.hash.slice(1)))).toEqual({ onboarding: token, messenger: "whatsapp" });

    window.location.href = `${origin}/?utm_source=facebook#from=hero`;
    await (await screen()).onConnect("https://nora.gsv.space", token);
    expect(new URL(assign.mock.lastCall![0]).hash).toBe(`#${token}`);
  });

  it("ignores slugs that are not plain", async () => {
    window.location.href = `${origin}/?utm_source=face%20book&utm_campaign=${"x".repeat(33)}#from=Hero%20Banner&example=Plan%20A`;
    const props = await screen();
    expect((await props.load()).state.attribution).toBeUndefined();
  });
});
