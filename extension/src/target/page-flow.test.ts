import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseAllDebuggers } from "../shared/debugger";
import { pageCommand } from "./commands/page";
import { pageReferences } from "./page-semantics";
import type { CommandContext, TargetFileSystem } from "./types";

afterEach(async () => {
  pageReferences.clear();
  await releaseAllDebuggers();
  vi.unstubAllGlobals();
});

describe("semantic page automation flow", () => {
  it("opens a virtualized chat by ref and scrolls its nested message region", async () => {
    const fixture = stubWhatsAppLikePage();

    const snapshotResult = await pageCommand.run(["snapshot", "--tab", "42", "--json"], context());
    expect(snapshotResult.exitCode).toBe(0);
    const snapshot = JSON.parse(snapshotResult.stdout) as {
      nodes: SnapshotNode[];
      referenceCount: number;
    };
    expect(snapshot.referenceCount).toBe(4);
    const chat = findNode(snapshot.nodes, "English");
    const messages = findNode(snapshot.nodes, "Mamá: Could you correct this?");
    expect(chat).toMatchObject({ role: "row" });
    expect(messages).toMatchObject({ role: "scroll-region", scroll: { vertical: true } });

    const clickResult = await pageCommand.run(["click", "--tab", "42", chat!.ref!], context());
    expect(clickResult.exitCode).toBe(0);
    expect(JSON.parse(clickResult.stdout)).toMatchObject({
      action: "click",
      delivered: {
        method: "cdp",
        requested: { ref: chat!.ref, role: "row", name: "English" },
      },
      observed: { semanticChanged: true },
    });

    const scrollResult = await pageCommand.run(
      ["scroll", "--tab", "42", messages!.ref!, "up"],
      context(),
    );
    expect(scrollResult.exitCode).toBe(0);
    expect(JSON.parse(scrollResult.stdout)).toMatchObject({
      action: "scroll",
      delivered: {
        method: "cdp",
        target: { ref: messages!.ref, role: "generic" },
        delta: { x: 0, y: -510 },
      },
      observed: {
        scroll: {
          before: { y: 900, maxY: 1800 },
          after: { y: 390, maxY: 1800 },
          changed: true,
        },
      },
    });

    expect(fixture.scriptingExecute).not.toHaveBeenCalled();
    expect(fixture.sendCommand.mock.calls).toContainEqual([
      { tabId: 42 },
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", button: "left" }),
    ]);
    expect(fixture.sendCommand.mock.calls).toContainEqual([
      { tabId: 42 },
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseWheel", deltaY: -510 }),
    ]);
  });
});

type SnapshotNode = {
  role: string;
  ref?: string;
  name?: string;
  scroll?: { vertical?: boolean };
  children?: SnapshotNode[];
};

function findNode(nodes: SnapshotNode[], name: string): SnapshotNode | null {
  for (const node of nodes) {
    if (node.name === name) return node;
    const child = findNode(node.children ?? [], name);
    if (child) return child;
  }
  return null;
}

function stubWhatsAppLikePage() {
  let lastGeometryNode = 103;
  let chatOpen = false;
  let messageScrollTop = 900;
  const sendCommand = vi.fn(async (
    _target: chrome.debugger.DebuggerSession,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<object> => {
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "frame-1", loaderId: "loader-1", url: "https://web.whatsapp.test/" } } };
      case "Accessibility.getFullAXTree":
        return accessibilityTree();
      case "DOMSnapshot.captureSnapshot":
        return domSnapshot();
      case "DOM.describeNode": {
        const backendNodeId = backendId(params);
        const descriptor = elementDescriptor(backendNodeId);
        return {
          node: {
            nodeId: backendNodeId,
            backendNodeId,
            localName: descriptor.tag,
            nodeName: descriptor.tag.toUpperCase(),
            frameId: "frame-1",
            attributes: descriptor.attributes,
          },
        };
      }
      case "Accessibility.getPartialAXTree": {
        const backendNodeId = Number(params?.backendNodeId ?? 0);
        const descriptor = elementDescriptor(backendNodeId);
        return {
          nodes: [{
            backendDOMNodeId: backendNodeId,
            role: { value: descriptor.role },
            name: { value: descriptor.name },
            properties: [{ name: "focusable", value: { value: backendNodeId === 103 } }],
          }],
        };
      }
      case "DOM.scrollIntoViewIfNeeded":
      case "Runtime.releaseObject":
        return {};
      case "DOM.getContentQuads": {
        lastGeometryNode = Number(params?.backendNodeId ?? 103);
        return { quads: lastGeometryNode === 104
          ? [[320, 0, 800, 0, 800, 600, 320, 600]]
          : [[0, 40, 300, 40, 300, 100, 0, 100]] };
      }
      case "DOM.getNodeForLocation":
        return { backendNodeId: lastGeometryNode, frameId: "frame-1" };
      case "DOM.resolveNode":
        return { object: { objectId: `node-${Number(params?.backendNodeId ?? 0)}`, subtype: "node" } };
      case "Runtime.callFunctionOn": {
        const declaration = String(params?.functionDeclaration ?? "");
        if (declaration.includes("connected:")) {
          const nodeId = Number(String(params?.objectId ?? "").replace("node-", ""));
          return { result: { value: elementState(nodeId, chatOpen, messageScrollTop) } };
        }
        throw new Error(`Unexpected Runtime.callFunctionOn: ${declaration}`);
      }
      case "Runtime.evaluate": {
        const expression = String(params?.expression ?? "");
        if (expression.includes("new MutationObserver")) {
          return { result: { value: { url: "https://web.whatsapp.test/", focus: null, mutations: 0 } } };
        }
        if (expression.includes("record?.observer?.disconnect")) {
          return {
            result: {
              value: {
                url: "https://web.whatsapp.test/",
                focus: chatOpen ? { tag: "div", role: "row", name: "English" } : null,
                mutations: 8,
              },
            },
          };
        }
        throw new Error(`Unexpected Runtime.evaluate: ${expression}`);
      }
      case "Input.dispatchMouseEvent":
        if (params?.type === "mouseReleased") chatOpen = true;
        if (params?.type === "mouseWheel") {
          messageScrollTop = Math.max(0, messageScrollTop + Number(params.deltaY ?? 0));
        }
        return {};
      default:
        throw new Error(`Unexpected CDP command: ${method}`);
    }
  });
  const scriptingExecute = vi.fn();
  vi.stubGlobal("chrome", {
    tabs: {
      get: vi.fn(async () => tab()),
      query: vi.fn(async () => [tab()]),
    },
    scripting: { executeScript: scriptingExecute },
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand,
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  });
  return { sendCommand, scriptingExecute };
}

function accessibilityTree(): object {
  return {
    nodes: [
      ax("root", "RootWebArea", "WhatsApp", undefined, ["search", "chats", "messages"]),
      { ...ax("search", "textbox", "Search or start new chat", 101), parentId: "root" },
      { ...ax("chats", "generic", "", 102, ["english"]), ignored: true, parentId: "root" },
      { ...ax("english", "row", "English", 103), parentId: "chats" },
      { ...ax("messages", "generic", "", 104, ["message"]), ignored: true, parentId: "root" },
      { ...ax("message", "StaticText", "Mamá: Could you correct this?", 105), parentId: "messages" },
    ],
  };
}

function domSnapshot(): object {
  return {
    strings: ["input", "div", "#text", "role", "row"],
    documents: [{
      nodes: {
        backendNodeId: [101, 102, 103, 104, 105],
        nodeName: [0, 1, 1, 1, 2],
        attributes: [[], [], [3, 4], [], []],
        isClickable: { index: [2] },
      },
      layout: {
        nodeIndex: [0, 1, 2, 3, 4],
        bounds: [[0, 0, 300, 40], [0, 40, 300, 560], [0, 40, 300, 60], [320, 0, 480, 600], [340, 40, 420, 24]],
        clientRects: [[0, 0, 300, 40], [0, 40, 300, 560], [0, 40, 300, 60], [320, 0, 480, 600], [340, 40, 420, 24]],
        scrollRects: [[0, 0, 300, 40], [0, 40, 300, 1800], [0, 40, 300, 60], [320, 0, 480, 2400], [340, 40, 420, 24]],
      },
    }],
  };
}

function ax(nodeId: string, role: string, name: string, backendDOMNodeId?: number, childIds: string[] = []) {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    backendDOMNodeId,
    childIds,
    frameId: "frame-1",
  };
}

function elementDescriptor(backendNodeId: number): {
  tag: string;
  role: string;
  name: string;
  attributes: string[];
} {
  switch (backendNodeId) {
    case 101:
      return { tag: "input", role: "textbox", name: "Search or start new chat", attributes: [] };
    case 102:
      return { tag: "div", role: "generic", name: "", attributes: [] };
    case 103:
      return { tag: "div", role: "row", name: "English", attributes: ["role", "row"] };
    case 104:
      return { tag: "div", role: "generic", name: "", attributes: [] };
    default:
      return { tag: "span", role: "text", name: "Mamá: Could you correct this?", attributes: [] };
  }
}

function elementState(nodeId: number, chatOpen: boolean, messageScrollTop: number): object {
  const messages = nodeId === 104;
  return {
    connected: true,
    tag: "div",
    focused: nodeId === 103 && chatOpen,
    disabled: false,
    readOnly: false,
    editable: false,
    scrollLeft: 0,
    scrollTop: messages ? messageScrollTop : 0,
    scrollWidth: messages ? 480 : 300,
    scrollHeight: messages ? 2400 : 60,
    clientWidth: messages ? 480 : 300,
    clientHeight: messages ? 600 : 60,
  };
}

function backendId(params: Record<string, unknown> | undefined): number {
  if (typeof params?.backendNodeId === "number") return params.backendNodeId;
  const objectId = String(params?.objectId ?? "");
  return Number(objectId.replace("node-", "")) || 103;
}

function tab(): chrome.tabs.Tab {
  return {
    id: 42,
    windowId: 7,
    index: 0,
    active: true,
    highlighted: true,
    pinned: false,
    frozen: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    title: "WhatsApp",
    url: "https://web.whatsapp.test/",
  };
}

function context(): CommandContext {
  return {
    cwd: "/",
    stdin: "",
    fs: {} as TargetFileSystem,
    now: () => 0,
  };
}
