import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabSummary } from "../shared/chrome";
import {
  captureSemanticSnapshot,
  formatSemanticSnapshot,
  isPageReference,
  normalizePageReference,
  PageReferenceStore,
} from "./page-semantics";

afterEach(() => vi.unstubAllGlobals());

describe("semantic page snapshots", () => {
  it("assigns snapshot-scoped refs in semantic order and identifies scroll regions", async () => {
    const sendCommand = vi.fn(async (
      _target: chrome.debugger.DebuggerSession,
      method: string,
    ) => fixtureResponse(method));
    stubDebugger(sendCommand);
    const store = new PageReferenceStore();

    const snapshot = await captureSemanticSnapshot({ tabId: 42 }, tab(), store);

    expect(snapshot).toMatchObject({
      tabId: 42,
      url: "https://web.whatsapp.test/",
      title: "WhatsApp",
      documentId: "loader-1",
      nodeCount: 5,
      referenceCount: 3,
      truncated: false,
    });
    const refs = collectRefs(snapshot.nodes);
    expect(refs).toHaveLength(3);
    expect(refs.every(isPageReference)).toBe(true);
    expect(normalizePageReference(refs[0]!.slice(1))).toBe(refs[0]);
    expect(normalizePageReference("sectione1")).toBeNull();
    expect(refs.map((ref) => ref.match(/e(\d+)$/)?.[1])).toEqual(["1", "2", "3"]);
    expect(store.resolve(refs[1]!)).toMatchObject({
      tabId: 42,
      documentId: "loader-1",
      backendNodeId: 102,
      role: "row",
      name: "English",
    });

    const outline = formatSemanticSnapshot(snapshot);
    expect(outline).toContain(`textbox ${refs[0]} "Search or start new chat"`);
    expect(outline).toContain(`row ${refs[1]} "English"`);
    expect(outline).toContain(`scroll-region ${refs[2]} "Mamá: Hello"`);
    expect(outline).toContain("[scrollable=y]");
    expect(outline).toContain("text \"Mamá: Hello\"");
  });

  it("does not expose password values or recycle refs between snapshots", async () => {
    const sendCommand = vi.fn(async (
      _target: chrome.debugger.DebuggerSession,
      method: string,
    ) => passwordFixtureResponse(method));
    stubDebugger(sendCommand);
    const store = new PageReferenceStore();

    const first = await captureSemanticSnapshot({ tabId: 42 }, tab(), store);
    const second = await captureSemanticSnapshot({ tabId: 42 }, tab(), store);
    const firstTextbox = first.nodes[0]?.children?.[0];
    const secondTextbox = second.nodes[0]?.children?.[0];

    expect(firstTextbox).toMatchObject({ role: "textbox" });
    expect(firstTextbox).not.toHaveProperty("value");
    expect(firstTextbox).not.toHaveProperty("valueLength");
    expect(firstTextbox?.ref).not.toBe(secondTextbox?.ref);
    expect(store.resolve(firstTextbox!.ref!)).toMatchObject({ backendNodeId: 201 });
  });
});

function collectRefs(nodes: Array<{ ref?: string; children?: unknown[] }>): string[] {
  const refs: string[] = [];
  const visit = (node: { ref?: string; children?: unknown[] }): void => {
    if (node.ref) refs.push(node.ref);
    for (const child of node.children ?? []) {
      visit(child as { ref?: string; children?: unknown[] });
    }
  };
  for (const node of nodes) visit(node);
  return refs;
}

function fixtureResponse(method: string): object {
  if (method === "Page.getFrameTree") {
    return { frameTree: { frame: { id: "frame-1", loaderId: "loader-1", url: "https://web.whatsapp.test/" } } };
  }
  if (method === "Accessibility.getFullAXTree") {
    return {
      nodes: [
        ax("root", "RootWebArea", "WhatsApp", undefined, ["search", "wrapper"]),
        {
          ...ax("search", "textbox", "Search or start new chat", 101, [], [{ name: "focusable", value: true }]),
          parentId: "root",
        },
        { ...ax("wrapper", "generic", "", undefined, ["chat", "messages"]), ignored: true, parentId: "root" },
        { ...ax("chat", "row", "English", 102), parentId: "wrapper" },
        { ...ax("messages", "generic", "", 103, ["message"]), ignored: true, parentId: "wrapper" },
        { ...ax("message", "StaticText", "Mamá: Hello", 104), parentId: "messages" },
      ],
    };
  }
  if (method === "DOMSnapshot.captureSnapshot") {
    return {
      strings: ["input", "type", "text", "div", "#text", "visible", "auto"],
      documents: [{
        nodes: {
          backendNodeId: [101, 102, 103, 104],
          nodeName: [0, 3, 3, 4],
          attributes: [[1, 2], [], [], []],
          isClickable: { index: [1] },
        },
        layout: {
          nodeIndex: [0, 1, 2, 3],
          styles: [[5, 5], [5, 5], [5, 6], [5, 5]],
          bounds: [[0, 0, 200, 40], [0, 40, 300, 60], [300, 0, 500, 600], [320, 40, 420, 20]],
          clientRects: [[0, 0, 200, 40], [0, 40, 300, 60], [300, 0, 500, 600], [320, 40, 420, 20]],
          scrollRects: [[0, 0, 200, 40], [0, 40, 300, 600], [300, 0, 500, 2400], [320, 40, 420, 20]],
        },
      }],
    };
  }
  throw new Error(`Unexpected CDP command: ${method}`);
}

function passwordFixtureResponse(method: string): object {
  if (method === "Page.getFrameTree") {
    return { frameTree: { frame: { id: "frame-1", loaderId: "loader-1", url: "https://example.test/" } } };
  }
  if (method === "Accessibility.getFullAXTree") {
    return {
      nodes: [
        ax("root", "RootWebArea", "Account", undefined, ["password"]),
        {
          ...ax("password", "textbox", "Password", 201, [], [{ name: "editable", value: true }]),
          parentId: "root",
          value: { type: "string", value: "correct horse battery staple" },
        },
      ],
    };
  }
  if (method === "DOMSnapshot.captureSnapshot") {
    return {
      strings: ["input", "type", "password", "visible"],
      documents: [{
        nodes: {
          backendNodeId: [201],
          nodeName: [0],
          attributes: [[1, 2]],
          isClickable: { index: [] },
        },
        layout: {
          nodeIndex: [0],
          styles: [[3, 3]],
          bounds: [[0, 0, 200, 40]],
          clientRects: [[0, 0, 200, 40]],
          scrollRects: [[0, 0, 200, 40]],
        },
      }],
    };
  }
  throw new Error(`Unexpected CDP command: ${method}`);
}

function ax(
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId?: number,
  childIds: string[] = [],
  properties: Array<{ name: string; value: string | number | boolean }> = [],
) {
  return {
    nodeId,
    role: { type: "role", value: role },
    name: { type: "computedString", value: name },
    backendDOMNodeId,
    childIds,
    properties: properties.map((property) => ({
      name: property.name,
      value: { type: typeof property.value, value: property.value },
    })),
    frameId: "frame-1",
  };
}

function tab(): TabSummary {
  return {
    id: 42,
    windowId: 7,
    index: 0,
    active: true,
    highlighted: true,
    pinned: false,
    audible: false,
    muted: false,
    status: "complete",
    title: "WhatsApp",
    url: "https://web.whatsapp.test/",
    favIconUrl: null,
  };
}

function stubDebugger(sendCommand: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("chrome", {
    debugger: {
      sendCommand,
    },
  });
}
