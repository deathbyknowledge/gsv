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
const request = vi.fn<GSVClient["request"]>();
const onFinish = vi.fn<() => Promise<void>>();
const connected: GsvClientStatus = { state: "connected", url: "wss://space.example/ws", username: "jessica", connectionId: "test", message: null };
const STARTING: ProfileState = {
  revision: 1, url: "https://jessica.ship.space", handle: "jessica", cid: "bafyreistarting",
  fields: { displayName: "jessica", about: "", contactPolicy: "requests" },
};
const WITH_PICTURE: ProfileState = { ...STARTING, revision: 2, cid: "bafyreipicture", avatar: { cid: "bafkpicture", mimeType: "image/png", size: 4 } };

function render(children: ComponentChildren) {
  return root.render(<GatewayProvider><QueryClientProvider client={cache}>{children}</QueryClientProvider></GatewayProvider>);
}
function Step() { tree = ProfileIntro({ ownerUid: 1000, profile: cache.getQueryData(["instrument", "profile", 1000]) ?? STARTING, finishing: false, finishError: false, onFinish }); return null; }
const node = <T,>(type: T) => collectNodes(tree).find((entry) => entry.type === type);
const button = (label: string) => collectNodes(tree).find((entry) => entry.type === Button && entry.props.label === label);
const write = async (about: string) => { await act(async () => { node(TextArea)!.props.onChange!(about); }); };
const submit = async () => { await act(async () => { button("Save and continue")!.props.onClick!(); }); };
const calls = () => request.mock.calls.map(([call, args]) => [call, args]);

beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("profile intro");
  request.mockReset();
  onFinish.mockReset();
  onFinish.mockResolvedValue(undefined);
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
  let intro: ProfileIntroState;
  let config: Map<string, string>;
  function Landing({ profile, landing }: { profile: ProfileState | undefined; landing: boolean }) { intro = useProfileIntro(1000, profile, landing); return null; }
  beforeEach(() => {
    config = new Map();
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
      throw new Error(`Unexpected request ${call}`);
    });
  });

  it("shows on the landing while the profile is the one the Ship started with, once", async () => {
    await render(<Landing profile={STARTING} landing={false} />);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sys.config.get", { key: SEEN_KEY }));
    expect(intro.shown).toBe(false);
    await render(<Landing profile={STARTING} landing />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await act(() => intro.finish());
    expect(config.get(SEEN_KEY)).toBe("1");
    await vi.waitFor(() => expect(intro.shown).toBe(false));
  });

  it("stays while a save changes the profile beneath it, and not for a profile already filled in", async () => {
    await render(<Landing profile={STARTING} landing />);
    await vi.waitFor(() => expect(intro.shown).toBe(true));
    await render(<Landing profile={WITH_PICTURE} landing />);
    expect(intro.shown).toBe(true);
    // Leaving the landing lets go: a profile filled in elsewhere has nothing to introduce.
    await render(<Landing profile={WITH_PICTURE} landing={false} />);
    await render(<Landing profile={WITH_PICTURE} landing />);
    expect(intro.shown).toBe(false);
  });

  it("asks nothing while the Ship hasn't published the profile", async () => {
    const { cid: _cid, ...unpublished } = STARTING;
    await render(<Landing profile={unpublished} landing />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve)); });
    expect(intro.shown).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("profile intro", () => {
  it("publishes a few words under the handle and finishes", async () => {
    request.mockImplementation(async (call) => {
      if (call === "profile.update") return { data: { profile: { ...STARTING, revision: 2, fields: { ...STARTING.fields, about: "Hi there." } } } };
      throw new Error(`Unexpected request ${call}`);
    });
    await render(<Step />);
    expect(button("Save and continue")?.props.disabled).toBe(true);
    await write("  Hi there. ");
    await submit();
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
    expect(calls()).toEqual([["profile.update", { expectedRevision: 1, fields: { displayName: "jessica", about: "Hi there.", contactPolicy: "requests" } }]]);
  });

  it("publishes the picture first, and a retry after the words fail doesn't publish it again", async () => {
    let updateFails = true;
    request.mockImplementation(async (call) => {
      if (call === "profile.avatar.set") return { data: { profile: WITH_PICTURE } };
      if (call === "profile.update") {
        if (updateFails) throw new Error("The repository is unavailable");
        return { data: { profile: { ...WITH_PICTURE, revision: 3, fields: { ...STARTING.fields, about: "Hi." } } } };
      }
      throw new Error(`Unexpected request ${call}`);
    });
    await render(<Step />);
    await act(async () => { node(ProfilePicturePicker)!.props.onChoose!(PICTURE); });
    await vi.waitFor(() => expect(button("Save and continue")?.props.disabled).toBe(false));
    await write("Hi.");
    await submit();
    await vi.waitFor(() => expect(collectNodes(tree).some((entry) => entry.type === "p" && entry.props.children === "The repository is unavailable")).toBe(true));
    expect(onFinish).not.toHaveBeenCalled();
    updateFails = false;
    await submit();
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
    expect(calls()).toEqual([
      ["profile.avatar.set", { expectedRevision: 1, mimeType: "image/png" }],
      ["profile.update", { expectedRevision: 2, fields: { displayName: "jessica", about: "Hi.", contactPolicy: "requests" } }],
      ["profile.update", { expectedRevision: 2, fields: { displayName: "jessica", about: "Hi.", contactPolicy: "requests" } }],
    ]);
  });

  it("finishes without publishing anything when skipped", async () => {
    await render(<Step />);
    await write("Never mind.");
    await act(async () => { button("Skip for now")!.props.onClick!(); });
    expect(onFinish).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
});
