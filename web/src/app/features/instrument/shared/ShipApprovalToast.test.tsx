import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { ApprovalToast } from "./ApprovalToast";
import { useShipApproval, type ShipApprovalClient } from "./useShipApproval";

const request = {
  pid: "ship", requestId: "r1", runId: "run1", callId: "c1", toolName: "Shell", syscall: "shell.exec",
  target: "gsv", args: { input: "ls ~/Downloads" }, createdAt: 1,
};

type Receive = Parameters<GSVClient["onSignal"]>[0];
const roots: ReturnType<typeof createTestRoot>[] = [];
beforeEach(() => vi.stubGlobal("document", {}));
afterEach(async () => { for (const root of roots.splice(0)) await root.unmount(); vi.unstubAllGlobals(); });

async function mount({ pending = null, chatShowsShip = false }: { pending?: typeof request | null; chatShowsShip?: boolean } = {}) {
  let receive!: Receive;
  const client: ShipApprovalClient = {
    onSignal: (next) => { receive = next; return () => {}; },
    proc: {
      history: vi.fn(async () => ({ ok: true as const, pid: "ship", messages: [], records: [], messageCount: 0, truncated: false, pendingHil: pending, format: 2 }) as never),
      hil: vi.fn(async () => ({ ok: true as const, pid: "ship", requestId: "r1", decision: "approve" as const, resumed: true }) as never),
    },
  };
  const observe = vi.fn(() => () => {});
  const openChat = vi.fn();
  let tree: ComponentChildren = null;
  function Probe({ inChat }: { inChat: boolean }) {
    const approval = useShipApproval({ client, connected: true, shipPid: "ship", observe });
    tree = ApprovalToast({ approval, hidden: inChat, onOpenChat: openChat });
    return null;
  }
  const root = createTestRoot("ship approval toast"); roots.push(root);
  const render = (inChat = chatShowsShip) => root.render(<Probe inChat={inChat} />);
  await render();
  await act(async () => { await Promise.resolve(); });
  const signal = (name: string, payload: unknown) => act(() => receive(name, payload as never));
  return { client, observe, openChat, render, signal, tree: () => tree, text: () => collectText(tree) };
}

describe("ship approval toast", () => {
  it("shows Ship's approval in the corner while the person is on another page", async () => {
    const app = await mount();
    expect(app.observe).toHaveBeenCalledWith("ship");
    expect(app.text()).toBe("");
    await app.signal("proc.run.hil.requested", request);
    expect(app.text()).toContain("Ship needs your approval");
    expect(app.text()).toContain("Allow once");
    expect(app.text()).toContain("Block");
    expect(app.text()).toContain("Always allow");
  });

  it("stays out of the way while Chat shows the card", async () => {
    const app = await mount({ chatShowsShip: true });
    await app.signal("proc.run.hil.requested", request);
    expect(app.text()).toBe("");
    await app.render(false);
    expect(app.text()).toContain("Ship needs your approval");
  });

  it("hydrates an approval that was already waiting", async () => {
    const app = await mount({ pending: request });
    expect(app.text()).toContain("Ship needs your approval");
  });

  it("decides through the same request and opens Chat", async () => {
    const app = await mount();
    await app.signal("proc.run.hil.requested", request);
    const buttons = collectNodes(app.tree()).filter((node) => node.type === "button");
    await act(async () => { await buttons.find((node) => collectText(node) === "Always allow")?.props.onClick?.(); });
    expect(app.client.proc.hil).toHaveBeenLastCalledWith({ pid: "ship", requestId: "r1", decision: "approve", remember: true });
    buttons.find((node) => collectText(node) === "Open Chat")?.props.onClick?.();
    expect(app.openChat).toHaveBeenCalled();
  });

  it.each([
    ["proc.run.tool.started", { pid: "ship", runId: "run1", callId: "c1" }],
    ["proc.run.finished", { pid: "ship", runId: "run1", status: "ok" }],
    ["process.exit", { pid: "ship" }],
  ])("clears when %s arrives, whichever client answered", async (name, payload) => {
    const app = await mount();
    await app.signal("proc.run.hil.requested", request);
    await app.signal(name, payload);
    expect(app.text()).toBe("");
  });

  it("ignores helpers' approvals and another run's end", async () => {
    const app = await mount();
    await app.signal("proc.run.hil.requested", { ...request, pid: "helper" });
    expect(app.text()).toBe("");
    await app.signal("proc.run.hil.requested", request);
    await app.signal("proc.run.finished", { pid: "ship", runId: "other-run", status: "ok" });
    expect(app.text()).toContain("Ship needs your approval");
  });
});
