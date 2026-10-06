import { describe, expect, it } from "vitest";
import { createPageSemantics, PageReferenceStore } from "@humansandmachines/gsv-browser/page-semantics";
import { createPageCommands } from "@humansandmachines/gsv-browser/commands/page";
import type { BrowserPageBackend, DebuggerBackend, TabSummary } from "@humansandmachines/gsv-browser/backend";
import { BrowserTargetFileSystem } from "./fs";
import { createRuntimeFileSystem } from "./runtime-fs";

describe("independent browser backends", () => {
  it("keeps simultaneous snapshots and references in their owning browser", async () => {
    const first = backend("first");
    const second = backend("second");
    const firstStore = new PageReferenceStore();
    const secondStore = new PageReferenceStore();
    const a = createPageSemantics(first.sendDebuggerCommand, firstStore);
    const b = createPageSemantics(second.sendDebuggerCommand, secondStore);
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      a.captureSemanticSnapshot({ tabId: 1 }, tab("first")),
      b.captureSemanticSnapshot({ tabId: 1 }, tab("second")),
    ]);
    expect(firstSnapshot.documentId).toBe("first-document");
    expect(secondSnapshot.documentId).toBe("second-document");
    const firstReference = firstSnapshot.nodes[0]!.children![0]!.ref!;
    const secondReference = secondSnapshot.nodes[0]!.children![0]!.ref!;
    expect(firstStore.resolve(firstReference).name).toBe("first button");
    expect(secondStore.resolve(secondReference).name).toBe("second button");
    expect(() => secondStore.resolve(firstReference)).toThrow("Unknown or expired");

    const pageBackend: BrowserPageBackend = {
      activeTab: async () => tab("second"),
      getTab: async () => tab("second"),
      captureTabPng: async () => { throw new Error("Unexpected screenshot"); },
      executeInTab: async () => { throw new Error("Unexpected script injection"); },
    };
    const { pageCommand } = createPageCommands(pageBackend, second, secondStore);
    const result = await pageCommand.run(["click", firstReference], {
      cwd: "/", stdin: "", now: Date.now,
      fs: new BrowserTargetFileSystem(createRuntimeFileSystem()),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown or expired page reference");
    expect(second.inputCalls).toEqual([]);
  });
});

function tab(name: string): TabSummary {
  return {
    id: 1, windowId: 1, index: 0, active: true, highlighted: true, pinned: false,
    audible: false, muted: false, status: "complete", title: name,
    url: `https://${name}.example/`, favIconUrl: null,
  };
}

function backend(name: string): DebuggerBackend<{ tabId: number }> & { inputCalls: string[] } {
  const inputCalls: string[] = [];
  return {
    inputCalls,
    acquireDebugger: async (tabId) => ({ tabId }),
    releaseDebugger: async () => {},
    async sendDebuggerCommand<T extends object | undefined>(_target: { tabId: number }, method: string): Promise<T> {
      let result: object;
      if (method === "Page.getFrameTree") {
        result = { frameTree: { frame: { id: "frame", loaderId: `${name}-document`, url: tab(name).url } } };
      } else if (method === "Accessibility.getFullAXTree") {
        result = { nodes: [
          { nodeId: "root", role: { value: "RootWebArea" }, name: { value: name }, childIds: ["button"] },
          { nodeId: "button", parentId: "root", role: { value: "button" }, name: { value: `${name} button` }, backendDOMNodeId: 10 },
        ] };
      } else if (method === "DOMSnapshot.captureSnapshot") {
        result = { strings: [], documents: [] };
      } else {
        inputCalls.push(method);
        throw new Error(`Unexpected command: ${method}`);
      }
      // The fixture supplies the response for the requested CDP command.
      return result as T;
    },
  };
}
