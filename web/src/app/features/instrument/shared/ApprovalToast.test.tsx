import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GSVClient } from "@humansandmachines/gsv/client";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { INSTRUMENT_PROCESSES_KEY, INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalPrompt } from "./ApprovalToast";

function process(pid: string, extra: Partial<ConsoleProcess> = {}): ConsoleProcess {
  return { pid, label: pid, state: "waiting_hil", rawState: "waiting_hil", uid: 1000, username: "crew", profile: "", cwd: "/home/crew",
    parentPid: null, interactive: false, personal: false, activeRunId: `${pid}-run`, queuedCount: 0, createdAt: 1, lastActiveAt: 1, ...extra };
}
function request(pid: string, createdAt: number, extra: Record<string, unknown> = {}) {
  return { pid, requestId: `${pid}-request`, runId: `${pid}-run`, callId: "call", toolName: "Shell", syscall: "shell.exec",
    target: "gsv", args: { input: `ls ${pid}` }, createdAt, ...extra };
}

const ship = process("ship", { personal: true, interactive: true, label: "ship", username: "ship" });
const crew = process("crew", { label: "tidy the downloads folder" });
let pending: Record<string, ReturnType<typeof request> | null>;
const roots: ReturnType<typeof createTestRoot>[] = [];

beforeEach(() => {
  vi.stubGlobal("document", {});
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  pending = { ship: request("ship", 1), crew: request("crew", 2) };
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(processes: ConsoleProcess[], { cardFor }: { cardFor?: string } = {}) {
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
    const pid = (args as { pid: string }).pid;
    if (call === "proc.history") return { data: { ok: true, pid, format: 2, messages: [], records: [], messageCount: 0,
      historyRevision: 0, historyGeneration: 1, historyResetRevision: 0, reset: false, hasMore: false, pendingHil: pending[pid] ?? null } };
    if (call === "proc.hil") return { data: { ok: true, pid, requestId: `${pid}-request`, decision: "approve", resumed: true } };
    throw new Error(`Unexpected request ${call}`);
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  cache.setQueryData(INSTRUMENT_PROCESSES_KEY, processes);
  cache.setQueryData(INSTRUMENT_TARGETS_KEY, []);
  const onOpen = vi.fn();
  let tree: ComponentChildren = null;
  function Prompt() { tree = ApprovalPrompt({ viewerUid: 1000, onOpen }); return null; }
  function Card({ pid }: { pid: string }) {
    const shown = pending[pid];
    // The card renders inside the root, so its hooks have a component to belong to.
    if (shown) ApprovalCard({ request: shown, who: "you", place: "Ship's home", onDecide: () => {} });
    return null;
  }
  const root = createTestRoot("approval toast"); roots.push(root);
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Prompt />{cardFor && <Card pid={cardFor} />}</QueryClientProvider></GatewayProvider>);
  const text = () => collectText(collectNodes(tree).find((node) => node.props.class === "approval-toast") ?? null);
  const live = () => collectText(collectNodes(tree).find((node) => node.props.role === "status") ?? null);
  const button = (label: string) => collectNodes(tree).find((node) => node.type === "button" && collectText(node).trim() === label);
  return { cache, request, onOpen, text, live, button };
}

describe("app-wide approval toast", () => {
  it("shows the Ship's approval on any other page and announces it", async () => {
    const app = await mount([ship]);
    await vi.waitFor(() => expect(app.text()).toContain("Ship is waiting for your approval"));
    expect(app.text()).toContain("ls ship");
    for (const label of ["Allow once", "Always allow", "Block", "Open"]) expect(app.button(label)).toBeDefined();
    expect(app.live()).toBe("Ship is waiting for your approval");
  });

  it("shows a delegated process's approval under its title and opens its own view", async () => {
    const app = await mount([crew]);
    await vi.waitFor(() => expect(app.text()).toContain("“Tidy the downloads folder” is waiting for your approval"));
    app.button("Open")?.props.onClick?.();
    expect(app.onOpen).toHaveBeenCalledWith(expect.objectContaining({ process: expect.objectContaining({ pid: "crew" }), request: expect.objectContaining({ requestId: "crew-request" }) }));
  });

  it("shows the newest request with a count of the rest", async () => {
    const app = await mount([ship, crew]);
    await vi.waitFor(() => expect(app.text()).toContain("1 more waiting"));
    expect(app.text()).toContain("“Tidy the downloads folder” is waiting for your approval");
  });

  it("hides a request only while its own card is visible", async () => {
    const app = await mount([ship, crew], { cardFor: "crew" });
    await vi.waitFor(() => expect(app.text()).toContain("Ship is waiting for your approval"));
    expect(app.text()).not.toContain("more waiting");
    expect(app.text()).not.toContain("downloads folder");
  });

  it("leaves out approvals that belong to someone else, as the Kernel only lets their owner decide", async () => {
    const app = await mount([process("theirs", { uid: 2000, label: "their task" }), ship]);
    await vi.waitFor(() => expect(app.text()).toContain("Ship is waiting for your approval"));
    expect(app.text()).not.toContain("more waiting");
    expect(app.request.mock.calls.some(([, args]) => (args as { pid?: string }).pid === "theirs")).toBe(false);
  });

  it("clears once the process stops waiting, whichever client answered", async () => {
    const app = await mount([ship]);
    await vi.waitFor(() => expect(app.text()).toContain("Ship is waiting"));
    pending.ship = null;
    await act(() => { app.cache.setQueryData(INSTRUMENT_PROCESSES_KEY, [{ ...ship, state: "running", rawState: "running" }]); });
    await vi.waitFor(() => expect(app.text()).toBe(""));
    expect(app.live()).toBe("");
  });

  it("decides through the same request as the card", async () => {
    const app = await mount([crew]);
    await vi.waitFor(() => expect(app.button("Always allow")?.props.disabled).toBe(false));
    await act(async () => { await app.button("Always allow")?.props.onClick?.(); });
    await vi.waitFor(() => expect(app.request).toHaveBeenCalledWith("proc.hil", { pid: "crew", requestId: "crew-request", decision: "approve", remember: true }));
  });
});
