import { GSVClient } from "@humansandmachines/gsv/client";
import type { ProfileFields, ProfileState } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { InviteContact } from "./InviteContact";

const ACCOUNT: ConsoleAccount = { uid: 1000, username: "esteve", displayName: "Esteve", relation: "self", runnable: false, gecos: "Esteve", capabilities: ["*"] };
const FIELDS: ProfileFields = { displayName: "esteve", about: "", contactPolicy: "requests" };
const URL_ = "https://esteve.ship.space/profile";
const live = (contactPolicy: ProfileFields["contactPolicy"], revision = 1) => ({ url: URL_, cid: "bafyprofile", contactPolicy, revision });
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;
const onEditProfile = vi.fn();

function Harness({ profile }: { profile: ProfileState }) {
  tree = InviteContact({ account: ACCOUNT, profile, onBusy: vi.fn(), onFind: vi.fn(), onEditProfile });
  return null;
}

async function show(profile: ProfileState) {
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness profile={profile} /></QueryClientProvider></GatewayProvider>);
}
const button = (label: string) => collectNodes(tree).find((node) => node.type === "button" && collectText(node) === label);
const link = () => collectNodes(tree).find((node) => node.type === "input")?.props.value;

beforeEach(() => {
  const presentation = JSON.stringify({ primaryDomain: "ship.space", signupUrl: "https://signup.ship.space/" });
  vi.stubGlobal("document", { getElementById: () => ({ textContent: presentation }) });
  vi.stubGlobal("window", { location: { protocol: "https:", host: "esteve.ship.space" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("invite contact");
  onEditProfile.mockReset();
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("inviting someone", () => {
  it("shows the reusable signup link once the live profile takes requests", async () => {
    await show({ revision: 1, url: URL_, handle: "esteve", draft: FIELDS, published: live("requests") });
    expect(link()).toBe("https://signup.ship.space/?invite=esteve");
    expect(collectText(tree)).toContain("It doesn’t expire.");
  });

  it("turns requests on and publishes before showing a link", async () => {
    const closed = { ...FIELDS, contactPolicy: "closed" as const };
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
      if (call === "profile.update") return { data: { profile: { revision: 2, url: URL_, draft: FIELDS, published: live("closed") } } };
      if (call === "profile.publish") return { data: { profile: { revision: 2, url: URL_, draft: FIELDS, published: live("requests", 2) } } };
      throw new Error(`Unexpected request ${call} ${JSON.stringify(args)}`);
    });
    await show({ revision: 1, url: URL_, handle: "esteve", draft: closed, published: live("closed") });
    expect(link()).toBeUndefined();
    expect(collectText(tree)).toContain("Your profile isn’t taking message requests");
    await act(async () => { button("turn on message requests")!.props.onClick!(); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([call, args]) => [call, args])).toEqual([
      ["profile.update", { expectedRevision: 1, draft: { ...closed, contactPolicy: "requests" } }],
      ["profile.publish", { expectedRevision: 2 }],
    ]);
  });

  it("saves a profile that was never saved before publishing it, as the Kernel publishes only a stored draft", async () => {
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
      if (call === "profile.update") return { data: { profile: { revision: 1, url: URL_, draft: FIELDS } } };
      if (call === "profile.publish") {
        if (JSON.stringify(args) !== JSON.stringify({ expectedRevision: 1 })) throw new Error("Profile changed; reload before publishing");
        return { data: { profile: { revision: 1, url: URL_, draft: FIELDS, published: live("requests") } } };
      }
      throw new Error(`Unexpected request ${call} ${JSON.stringify(args)}`);
    });
    // The Kernel answers with its default draft, already open to requests, until the owner saves one.
    await show({ revision: 0, url: URL_, handle: "esteve", draft: FIELDS });
    await act(async () => { button("turn on message requests")!.props.onClick!(); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([call, args]) => [call, args])).toEqual([
      ["profile.update", { expectedRevision: 0, draft: FIELDS }],
      ["profile.publish", { expectedRevision: 1 }],
    ]);
    expect(collectText(tree)).not.toContain("reload before publishing");
  });

  it("asks to review unpublished profile changes rather than publish them unseen", async () => {
    const request = vi.spyOn(GSVClient.prototype, "request");
    await show({ revision: 2, url: URL_, handle: "esteve", draft: { ...FIELDS, about: "Draft" }, published: live("closed") });
    expect(button("turn on message requests")).toBeUndefined();
    await act(async () => { button("review my profile")!.props.onClick!(); });
    expect(onEditProfile).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("asks a private profile to go public", async () => {
    await show({ revision: 1, url: URL_, handle: "esteve", draft: FIELDS });
    expect(collectText(tree)).toContain("Your profile is private");
    expect(button("turn on message requests")).toBeDefined();
  });
});
