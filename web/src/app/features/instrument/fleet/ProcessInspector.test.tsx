import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GSVClient } from "@humansandmachines/gsv/client";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import { collectNodes, collectText, createTestRoot, deferred } from "../../../testing/testHarness";
import { ProcessInspector } from "./Fleet";

const abort = vi.fn<GSVClient["proc"]["abort"]>();

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => { vi.stubGlobal("document", {}); abort.mockReset(); });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

async function inspector() {
  const client = new GSVClient();
  client.proc.abort = abort;
  const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const root = createTestRoot("Process inspector");
  let process: ConsoleProcess = {
    pid: "approval-process", label: "approval fixture", state: "waiting_hil", rawState: "waiting_hil",
    uid: 1001, username: "algo", profile: "default", cwd: "/home/algo", parentPid: null,
    interactive: true, personal: true, activeRunId: "approval-run", queuedCount: 0, createdAt: 1, lastActiveAt: 1,
  };
  let tree: ComponentChildren;
  function Harness() {
    tree = ProcessInspector({ client, process, model: null, cost: null, responsibilities: 0, canEditAi: false,
      now: 1, onZen: () => undefined, lines: [], placeLabelFor: (target) => target });
    return null;
  }
  const render = () => root.render(<QueryClientProvider client={cache}><Harness /></QueryClientProvider>);
  cleanup.push(async () => { await root.unmount(); cache.clear(); });
  await render();
  return {
    text: () => collectText(tree),
    stop: () => {
      const button = collectNodes(tree).find((node) => node.type === "button" && collectText(node) === "stop");
      if (!button) throw new Error("Stop action is missing");
      return button.props;
    },
    update: async (next: Partial<ConsoleProcess>) => { process = { ...process, ...next }; await render(); },
  };
}

describe("Fleet process cancellation", () => {
  it("can abort an approval wait and keeps the request scoped to the displayed run", async () => {
    const result = deferred<Awaited<ReturnType<GSVClient["proc"]["abort"]>>>();
    abort.mockReturnValue(result.promise);
    const view = await inspector();
    expect(view.stop().disabled).toBe(false);
    await act(async () => { await view.stop().onClick?.(); });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledWith({ pid: "approval-process", runId: "approval-run" }));
    await vi.waitFor(() => expect(view.stop().disabled).toBe(true));
    await view.update({ activeRunId: "replacement-run", state: "running" });
    result.resolve({ ok: true, pid: "approval-process", aborted: true });
    await vi.waitFor(() => expect(view.stop().disabled).toBe(false));
    expect(abort).toHaveBeenCalledTimes(1);
    await view.update({ state: "idle", activeRunId: null });
    expect(view.stop().disabled).toBe(true);
    await view.update({ state: "queued", queuedCount: 1 });
    expect(view.stop().disabled).toBe(true);
  });

  it("keeps an approval wait cancellable after an abort request fails", async () => {
    abort.mockRejectedValueOnce(new Error("Abort unavailable"))
      .mockResolvedValue({ ok: true, pid: "approval-process", aborted: true });
    const view = await inspector();
    await act(async () => { await view.stop().onClick?.(); });
    await vi.waitFor(() => expect(view.text()).toContain("Abort unavailable"));
    expect(view.stop().disabled).toBe(false);
    await act(async () => { await view.stop().onClick?.(); });
    await vi.waitFor(() => expect(view.text()).not.toContain("Abort unavailable"));
    expect(abort).toHaveBeenCalledTimes(2);
  });
});
