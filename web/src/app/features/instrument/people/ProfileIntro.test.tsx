import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import type { ProfileState } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { Button } from "../../../components/ui/Button";
import { TextArea } from "../../../components/ui/TextArea";
import type { ProfilePicture } from "./profilePicture";
import { ProfilePicturePicker } from "./ProfilePicturePicker";
import { ProfileIntro, useProfileIntro, type ProfileIntroState } from "./ProfileIntro";

const PICTURE: ProfilePicture = { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" };
const SEEN_KEY = "users/1000/ui/profile_intro_seen";

let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;
let intro: ProfileIntroState;
let config: Map<string, string>;
const request = vi.fn<GSVClient["request"]>();
const connected: GsvClientStatus = { state: "connected", url: "wss://space.example/ws", username: "jessica", connectionId: "test", message: null };
const STARTING: ProfileState = {
  revision: 1, url: "https://jessica.ship.space", handle: "jessica", cid: "bafyreistarting",
  fields: { displayName: "jessica", about: "", contactPolicy: "requests" },
};
const WITH_PICTURE: ProfileState = { ...STARTING, revision: 2, cid: "bafyreipicture", avatar: { cid: "bafkpicture", mimeType: "image/png", size: 4 } };

function render(children: ComponentChildren) {
  return root.render(<GatewayProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></GatewayProvider>);
}
/** People's use: the hook holds the intro, and the landing shows the step while it's open. */
function Landing({ profile, landing = true }: { profile: ProfileState; landing?: boolean }) {
  intro = useProfileIntro(1000, profile, landing);
  tree = ProfileIntro({ profile: cache.getQueryData(["instrument", "profile", 1000]) ?? profile, intro });
  return null;
}
/** Answers the owner's config, and the profile calls through `profile`. */
function respond(profile: (call: string) => { profile: ProfileState } = (call) => { throw new Error(`Unexpected request ${call}`); }) {
  request.mockImplementation(async (call, args) => {
    if (call === "sys.config.get") {
      const { key } = z.object({ key: z.string() }).parse(args);
      return { data: { entries: config.has(key) ? [{ key, value: config.get(key)! }] : [] } };
    }
    if (call === "sys.config.set") {
      const { key, value } = z.object({ key: z.string(), value: z.string() }).parse(args);
      config.set(key, value);
      return { data: { ok: true } };
    }
    return { data: await profile(call) };
  });
}
const node = <T,>(type: T) => collectNodes(tree).find((entry) => entry.type === type);
const button = (label: string) => collectNodes(tree).find((entry) => entry.type === Button && entry.props.label === label);
const write = async (about: string) => { await act(async () => { node(TextArea)!.props.onChange!(about); }); };
const submit = async () => { await act(async () => { button("Save and continue")!.props.onClick!(); }); };
const profileCalls = () => request.mock.calls.filter(([call]) => call.startsWith("profile.")).map(([call, args]) => [call, args]);

beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("profile intro");
  config = new Map();
  request.mockReset();
  respond();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { search: "", origin: "https://jessica.ship.space" } });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue(connected);
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(request);
});
afterEach(async () => {
  await root.unmount();
  cache.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("when People introduces the profile", () => {
  it("shows on the landing while the profile is the one the Ship started with, once", async () => {
    await render(<Landing profile={STARTING} landing={false} />);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.get", { key: SEEN_KEY }));
    expect(intro.shown).toBe(false);
    await render(<Landing profile={STARTING} />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await act(() => intro.finish());
    expect(config.get(SEEN_KEY)).toBe("1");
    await vi.waitFor(() => expect(intro.shown).toBe(false));
  });

  it("stays while a save changes the profile beneath it, and not for a profile already filled in", async () => {
    await render(<Landing profile={STARTING} />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await render(<Landing profile={WITH_PICTURE} />);
    expect(intro.shown).toBe(true);
    // Leaving the landing with nothing unsaved lets go: a profile filled in elsewhere has nothing to introduce.
    await render(<Landing profile={WITH_PICTURE} landing={false} />);
    await render(<Landing profile={WITH_PICTURE} />);
    expect(intro.shown).toBe(false);
  });

  it("keeps what the owner wrote while they open something else in People", async () => {
    await render(<Landing profile={STARTING} />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await write("Hi there.");
    expect(intro.dirty).toBe(true);
    await render(<Landing profile={STARTING} landing={false} />);
    expect(intro.shown).toBe(false);
    expect(intro.dirty).toBe(true);
    // Even after a bio is added in the editor, the draft waits for its own save or skip.
    await render(<Landing profile={{ ...STARTING, revision: 2, fields: { ...STARTING.fields, about: "From the editor." } }} landing={false} />);
    await render(<Landing profile={{ ...STARTING, revision: 2, fields: { ...STARTING.fields, about: "From the editor." } }} />);
    expect(intro.shown).toBe(true);
    expect(node(TextArea)?.props.value).toBe("Hi there.");
  });

  it("asks nothing while the Ship hasn't published the profile", async () => {
    const { cid: _cid, ...unpublished } = STARTING;
    await render(<Landing profile={unpublished} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve)); });
    expect(intro.shown).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("profile intro", () => {
  it("publishes a few words under the handle and finishes", async () => {
    respond((call) => {
      if (call === "profile.update") return { profile: { ...STARTING, revision: 2, fields: { ...STARTING.fields, about: "Hi there." } } };
      throw new Error(`Unexpected request ${call}`);
    });
    await render(<Landing profile={STARTING} />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    expect(button("Save and continue")?.props.disabled).toBe(true);
    await write("  Hi there. ");
    await submit();
    await vi.waitFor(() => expect(config.get(SEEN_KEY)).toBe("1"));
    expect(profileCalls()).toEqual([["profile.update", { expectedRevision: 1, fields: { displayName: "jessica", about: "Hi there.", contactPolicy: "requests" } }]]);
  });

  it("publishes the picture first, and a retry after the words fail doesn't publish it again", async () => {
    let updateFails = true;
    respond((call) => {
      if (call === "profile.avatar.set") return { profile: WITH_PICTURE };
      if (call === "profile.update") {
        if (updateFails) throw new Error("The repository is unavailable");
        return { profile: { ...WITH_PICTURE, revision: 3, fields: { ...STARTING.fields, about: "Hi." } } };
      }
      throw new Error(`Unexpected request ${call}`);
    });
    await render(<Landing profile={STARTING} />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await act(async () => { node(ProfilePicturePicker)!.props.onChoose!(PICTURE); });
    await write("Hi.");
    await submit();
    await vi.waitFor(() => expect(collectNodes(tree).some((entry) => entry.type === "p" && entry.props.children === "The repository is unavailable")).toBe(true));
    expect(config.has(SEEN_KEY)).toBe(false);
    updateFails = false;
    await submit();
    await vi.waitFor(() => expect(config.get(SEEN_KEY)).toBe("1"));
    expect(profileCalls()).toEqual([
      ["profile.avatar.set", { expectedRevision: 1, mimeType: "image/png" }],
      ["profile.update", { expectedRevision: 2, fields: { displayName: "jessica", about: "Hi.", contactPolicy: "requests" } }],
      ["profile.update", { expectedRevision: 2, fields: { displayName: "jessica", about: "Hi.", contactPolicy: "requests" } }],
    ]);
  });

  it("publishes only the picture when a bio was written elsewhere", async () => {
    const written = { ...STARTING, revision: 2, cid: "bafyreiwritten", fields: { ...STARTING.fields, about: "From the editor." } };
    respond((call) => {
      if (call === "profile.avatar.set") return { profile: { ...written, revision: 3, avatar: WITH_PICTURE.avatar } };
      throw new Error(`Unexpected request ${call}`);
    });
    await render(<Landing profile={STARTING} />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await act(async () => { node(ProfilePicturePicker)!.props.onChoose!(PICTURE); });
    await render(<Landing profile={written} />);
    await submit();
    await vi.waitFor(() => expect(config.get(SEEN_KEY)).toBe("1"));
    expect(profileCalls()).toEqual([["profile.avatar.set", { expectedRevision: 2, mimeType: "image/png" }]]);
  });

  it("finishes without publishing anything when skipped", async () => {
    await render(<Landing profile={STARTING} />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await write("Never mind.");
    await act(async () => { button("Skip for now")!.props.onClick!(); });
    await vi.waitFor(() => expect(config.get(SEEN_KEY)).toBe("1"));
    expect(profileCalls()).toEqual([]);
  });
});
