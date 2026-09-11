import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { GSVClient } from "@humansandmachines/gsv/client";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { SessionProvider } from "../../../services/session/SessionProvider";
import { createSessionService } from "../../../services/session/sessionService";
import { TerminalProvider } from "../../../services/terminal/TerminalProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { FleetApproval } from "../fleet/FleetApproval";
import { WireSync } from "../wire/WireSync";
import { INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import { DelegatedApprovals, delegatedApprovalProcesses } from "./DelegatedApprovals";
import { useZenProcess } from "./useZenProcess";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function process(pid: string, parentPid: string | null, overrides: Partial<ConsoleProcess> = {}): ConsoleProcess {
  return { pid, parentPid, uid: 1000, label: pid, username: "algo", profile: "", cwd: "/home/algo",
    personal: false, interactive: false, state: "waiting_hil", rawState: "waiting_hil", activeRunId: `${pid}-run`,
    queuedCount: 0, createdAt: 1, lastActiveAt: 1, ...overrides };
}

describe("Ship pending approvals", () => {
  it("follows a mounted Ship replacement without redirecting a deleted helper or mixing owners", async () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" },
      sessionStorage: { getItem: () => null, setItem: () => {} } });
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const listeners = new Set<Parameters<GSVClient["onSignal"]>[0]>();
    vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    const child = process("child", "ship");
    const helperChild = process("helper-child", "helper");
    const foreignShip = process("foreign-ship", null, { uid: 2000, personal: true, state: "idle", activeRunId: null });
    const foreignChild = process("foreign-child", "foreign-ship", { uid: 2000 });
    const replacement = process("replacement", null, { personal: true, state: "idle", activeRunId: null });
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
      if (call === "proc.list") return { data: { processes: [foreignShip, foreignChild, replacement, child, helperChild] } };
      throw new Error(`Unexpected request ${call}`);
    });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    cache.setQueryData(INSTRUMENT_PROCESSES_KEY, [
      process("ship", null, { personal: true, state: "idle", activeRunId: null }),
      process("helper", "ship", { state: "idle", activeRunId: null }),
      child, helperChild, foreignShip, foreignChild,
    ]);
    const root = createTestRoot("Ship replacement");
    const onError = vi.fn();
    let shipPid: string | null = null;
    let helperPid: string | null = null;
    let shipTree: ComponentChildren;
    let helperTree: ComponentChildren;
    function Harness() {
      shipPid = useZenProcess(null, onError);
      helperPid = useZenProcess("helper", onError);
      shipTree = DelegatedApprovals({ pid: shipPid ?? "", onFleet: () => {} });
      helperTree = DelegatedApprovals({ pid: helperPid ?? "", onFleet: () => {} });
      return null;
    }
    try {
      await root.render(<GatewayProvider><SessionProvider createService={(client) => ({
        ...createSessionService(client), start: async () => {},
      })}><TerminalProvider><QueryClientProvider client={cache}><WireSync /><Harness /></QueryClientProvider></TerminalProvider></SessionProvider></GatewayProvider>);
      await vi.waitFor(() => expect(shipPid).toBe("ship"));
      expect(collectText(shipTree)).toMatch(/child\s+is waiting for your approval/);
      expect(collectText(helperTree)).toMatch(/helper-child\s+is waiting for your approval/);
      await act(async () => {
        for (const listener of listeners) {
          listener("process.exit", { pid: "ship" });
          listener("process.exit", { pid: "helper" });
        }
      });
      await vi.waitFor(() => expect(collectText(helperTree)).toBe(""));
      expect(shipPid).toBe("ship");
      expect(helperPid).toBe("helper");
      expect(request).not.toHaveBeenCalled();
      await act(async () => {
        for (const listener of listeners) listener("proc.changed", { pid: "replacement", changes: ["created"], runtime: {
          state: "idle", activeRunId: null, queuedCount: 0, lastActiveAt: 10,
        } });
      });
      await vi.waitFor(() => expect(shipPid).toBe("replacement"));
      expect(collectNodes(shipTree).filter((node) => node.type === FleetApproval).map((node) => node.props))
        .toMatchObject([{ pid: "child", runId: "child-run" }, { pid: "helper-child", runId: "helper-child-run" }]);
      expect(collectText(shipTree)).not.toContain("foreign-child");
      expect(helperPid).toBe("helper");
      expect(collectText(helperTree)).toBe("");
      expect(request.mock.calls.map(([call]) => call)).toEqual(["proc.list"]);
      expect(onError).not.toHaveBeenCalled();
    } finally { await root.unmount(); cache.clear(); }
  });

  it("shows and clears a child's approval in mounted Ship from owner registry signals alone", async () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", { location: { protocol: "https:", host: "example.com" },
      sessionStorage: { getItem: () => null, setItem: () => {} } });
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const listeners = new Set<Parameters<GSVClient["onSignal"]>[0]>();
    vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    const request = vi.spyOn(GSVClient.prototype, "request");
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    cache.setQueryData(INSTRUMENT_PROCESSES_KEY, [
      process("ship", null, { personal: true, state: "idle", activeRunId: null }),
      process("child", "ship", { state: "running" }),
    ]);
    const root = createTestRoot("Ship approvals");
    let tree: ComponentChildren;
    function Harness() { tree = DelegatedApprovals({ pid: "ship", onFleet: () => {} }); return null; }
    try {
      await root.render(<GatewayProvider><SessionProvider createService={(client) => ({
        ...createSessionService(client), start: async () => {},
      })}><TerminalProvider><QueryClientProvider client={cache}><WireSync /><Harness /></QueryClientProvider></TerminalProvider></SessionProvider></GatewayProvider>);
      expect(collectText(tree)).toBe("");
      await act(async () => {
        for (const listener of listeners) listener("proc.changed", { pid: "child", changes: ["state"], runtime: {
          state: "waiting_hil", activeRunId: "child-run", queuedCount: 0, lastActiveAt: 10,
        } });
      });
      await vi.waitFor(() => expect(collectText(tree)).toMatch(/child\s+is waiting for your approval/));
      expect(collectNodes(tree).find((node) => node.type === FleetApproval)?.props)
        .toMatchObject({ pid: "child", runId: "child-run" });
      expect(cache.getQueryData<ConsoleProcess[]>(INSTRUMENT_PROCESSES_KEY)?.[0]).toMatchObject({ state: "idle", activeRunId: null });
      await act(async () => {
        for (const listener of listeners) listener("proc.changed", { pid: "child", changes: ["state"], runtime: {
          state: "idle", activeRunId: null, queuedCount: 0, lastActiveAt: 11,
        } });
      });
      await vi.waitFor(() => expect(collectText(tree)).toBe(""));
      expect(request).not.toHaveBeenCalled();
    } finally { await root.unmount(); cache.clear(); }
  });

  const processes = [
    process("ship", null, { personal: true, state: "idle", activeRunId: null }),
    process("parent", "ship", { state: "idle", activeRunId: null }),
    process("child", "parent"),
    process("older-work", "replaced-ship"),
    process("other-owner", "ship", { uid: 2000 }),
    process("finished", "ship", { state: "idle", activeRunId: null }),
  ];

  it("shows pending child work even when Ship is idle, including work from an older Ship process", () => {
    expect(delegatedApprovalProcesses(processes, "ship").map(({ pid }) => pid)).toEqual(["child", "older-work"]);
  });

  it("scopes a helper to its descendants and never mixes owners from an administrator's list", () => {
    expect(delegatedApprovalProcesses(processes, "parent").map(({ pid }) => pid)).toEqual(["child"]);
    expect(delegatedApprovalProcesses(processes, "missing")).toEqual([]);
    expect(delegatedApprovalProcesses([process("unknown-owner", null, { uid: null, personal: true }), ...processes], "unknown-owner")).toEqual([]);
  });

  it("removes cancelled requests and rejects broken or cyclic ancestry", () => {
    const cancelled = processes.map((entry) => entry.pid === "child" ? { ...entry, activeRunId: null } : entry);
    expect(delegatedApprovalProcesses(cancelled, "parent")).toEqual([]);
    expect(delegatedApprovalProcesses([process("a", "b"), process("b", "a"), process("c", null)], "c")).toEqual([]);
  });
});
