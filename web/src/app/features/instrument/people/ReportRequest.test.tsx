import { GSVClient } from "@humansandmachines/gsv/client";
import type { ApproachSummary } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { ReportRequest } from "./ReportRequest";

type ElementProps = {
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  children?: ComponentChildren;
};

const stranger: ApproachSummary = {
  id: "approach:stranger", direction: "incoming", requestId: "request:stranger", peerDid: "did:plc:strangerstrangerstranger", displayName: "Stranger",
  conversationId: "conv:stranger", state: "pending", revision: 1, delivery: "received", messageSequence: 1, createdAtMs: 1, updatedAtMs: 1, expiresAtMs: 2,
};
const reported = vi.fn<(block: boolean) => void>();
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
let cache: QueryClient;

function Harness() { tree = ReportRequest({ request: stranger, canBlock: true, onReported: reported, onClose: () => {} }); return null; }
function elements(type: string): Array<VNode<ElementProps>> {
  // SAFETY: these are the intrinsic elements ReportRequest renders above.
  return collectNodes(tree).filter((candidate) => candidate.type === type) as Array<VNode<ElementProps>>;
}
const checkboxes = () => elements("input").filter((node) => node.props.type === "checkbox");
const choose = (category: string) => act(() => { elements("input").find((node) => node.props.value === category)!.props.onChange!({ currentTarget: { checked: true } }); });
const tick = (index: number) => act(() => { checkboxes()[index].props.onChange!({ currentTarget: { checked: true } }); });
const send = () => act(async () => { elements("form")[0].props.onSubmit!({ preventDefault: () => {} }); });

async function mount() {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "approach.report") return { data: { approach: { ...stranger, state: "declined", reportedAtMs: 3 } } };
    throw new Error(`Unexpected request ${call}`);
  });
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  return request;
}

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  reported.mockReset();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createTestRoot("report request");
});
afterEach(async () => { await root.unmount(); cache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("reporting a stranger's request", () => {
  it("sends who sent it and why, leaving their name and message out unless the person includes them", async () => {
    const request = await mount();
    expect(checkboxes().map((node) => node.props.checked)).toEqual([false, false]);
    expect(elements("button").find((node) => node.props.type === "submit")?.props.disabled).toBe(true);
    await choose("spam");
    await send();
    await vi.waitFor(() => expect(reported).toHaveBeenCalledWith(false));
    expect(request).toHaveBeenCalledWith("approach.report", { approachId: stranger.id, category: "spam", includeMessage: false });
  });

  it("includes their name and message, and blocks them, only when the person asks", async () => {
    const request = await mount();
    await choose("harassment");
    await tick(0);
    await tick(1);
    await send();
    await vi.waitFor(() => expect(reported).toHaveBeenCalledWith(true));
    expect(request).toHaveBeenCalledWith("approach.report", { approachId: stranger.id, category: "harassment", includeMessage: true });
  });
});
