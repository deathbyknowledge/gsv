import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";
import { GatewayProvider, WEB_PEER } from "../../../services/gateway/GatewayProvider";
import { SessionProvider } from "../../../services/session/SessionProvider";
import { createSessionService } from "../../../services/session/sessionService";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { Feedback } from "./Feedback";

const fixture = { available: true, request: vi.fn<GSVClient["request"]>() };
const listeners = new Set<(status: GsvClientStatus) => void>();
const connectedStatus: GsvClientStatus = { state: "connected", url: null, username: null, connectionId: "test", message: null };

type ElementProps = {
  onInput?: (event: { currentTarget: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  onClick?: () => void;
  value?: string;
  disabled?: boolean;
  children?: ComponentChildren;
};
let tree: ComponentChildren;
let root: ReturnType<typeof createTestRoot>;
function Harness() { tree = Feedback({ view: "zen" }); return null; }
function element(type: string): VNode<ElementProps> {
  // SAFETY: these are the explicitly named elements returned by Feedback above.
  const node = collectNodes(tree).find((candidate) => candidate.type === type) as VNode<ElementProps> | undefined;
  if (!node) throw new Error(`Missing ${type}`);
  return node;
}
const type = (value: string) => act(() => element("textarea").props.onInput!({ currentTarget: { value } }));
const send = () => act(async () => { element("form").props.onSubmit!({ preventDefault: () => {} }); });

beforeEach(() => {
  vi.stubGlobal("document", {});
  fixture.available = true;
  vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" }, sessionStorage: { getItem: () => null, setItem: () => {} } });
  listeners.clear();
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue(connectedStatus);
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(listener => { listeners.add(listener); return () => listeners.delete(listener); });
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(fixture.request);
  fixture.request.mockReset();
  root = createTestRoot("feedback");
});
afterEach(async () => { await root.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });


async function mount() {
  await root.render(<GatewayProvider><SessionProvider createService={client => ({
    ...createSessionService(client), start: async () => {}, subscribe: () => () => {},
    snapshot: () => ({ phase: "ready", url: "wss://example.com/ws", username: "person", connectionId: "test", message: null,
      server: { version: "0.6.2", release: "test", features: fixture.available ? ["operator-feedback"] : [] } }),
  })}><Harness /></SessionProvider></GatewayProvider>);
}

describe("feedback", () => {
  it("appears only when the operator advertises feedback", async () => {
    fixture.available = false;
    await mount();
    expect(collectNodes(tree)).toHaveLength(0);
  });

  it("retains a failed draft and retries the same report identity", async () => {
    fixture.request.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: { id: "receipt" } });
    await mount();
    await type("  The file will not open.  ");
    await send();
    expect(collectText(tree)).toContain("Could not send. Try again.");
    expect(element("textarea").props.value).toBe("  The file will not open.  ");
    const first = fixture.request.mock.calls[0];
    expect(first[0]).toBe("sys.feedback");
    expect(first[1]).toMatchObject({ message: "The file will not open.", context: { view: "zen", platform: "web", version: WEB_PEER.version } });
    await send();
    expect(fixture.request.mock.calls[1][1]).toEqual(first[1]);
    expect(collectText(tree)).toContain("Thanks for the feedback.");
    await act(() => element("button").props.onClick!());
    expect(element("textarea").props.value).toBe("");
  });

  it("uses a new identity if an unsuccessful report is edited", async () => {
    fixture.request.mockRejectedValue(new Error("offline"));
    await mount();
    await type("First report"); await send();
    await type("More detail"); await send();
    expect(fixture.request.mock.calls[1][1]).not.toEqual(fixture.request.mock.calls[0][1]);
  });

  it("blocks empty and disconnected submissions", async () => {
    await mount();
    await type("   "); await send();
    await act(() => { for (const listener of listeners) listener({ ...connectedStatus, state: "disconnected" }); });
    await type("A report"); await send();
    expect(fixture.request).not.toHaveBeenCalled();
    expect(collectText(tree)).toContain("Waiting for connection.");
  });

  it("allows only one in-flight submission and cancels it on unmount", async () => {
    fixture.request.mockImplementation(() => new Promise(() => {}));
    await mount();
    await type("A report"); await send(); await send();
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(element("textarea").props.disabled).toBe(true);
    const signal = fixture.request.mock.calls[0][2]!.signal!;
    await root.unmount();
    expect(signal.aborted).toBe(true);
  });
});
