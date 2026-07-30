import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseAllDebuggers } from "../shared/debugger";
import {
  clickPageElement,
  scrollPage,
  sendPageKey,
  typePageText,
} from "./page-actions";
import { PageReferenceStore, type PageElementReference } from "./page-semantics";

afterEach(async () => {
  await releaseAllDebuggers();
  vi.unstubAllGlobals();
});

describe("CDP page actions", () => {
  it("delivers a native click to the hit-tested element and reports observed changes", async () => {
    const fixture = stubCdp({
      states: [elementState({ focused: false }), elementState({ focused: true })],
      mutations: 4,
    });
    const { store, reference } = referencedElement();

    const result = await clickPageElement(
      42,
      { kind: "reference", reference },
      undefined,
      store,
    );

    expect(inputMethods(fixture.sendCommand)).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ]);
    expect(result).toMatchObject({
      action: "click",
      delivered: {
        method: "cdp",
        requested: { ref: reference.ref, role: "row", name: "English" },
        receiver: { ref: reference.ref, role: "row", name: "English" },
        point: { x: 150, y: 70 },
      },
      observed: {
        mutationCount: 4,
        targetStateChanged: true,
        semanticChanged: true,
      },
    });
    expect(fixture.attach).toHaveBeenCalledWith({ tabId: 42 }, "1.3");
    expect(fixture.detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it("refuses to click through an unrelated overlay", async () => {
    const fixture = stubCdp({ receiverId: 999, relatedReceiver: false });
    const { store, reference } = referencedElement();

    await expect(clickPageElement(
      42,
      { kind: "reference", reference },
      undefined,
      store,
    )).rejects.toThrow('Click target is occluded by dialog "Blocking dialog"');
    expect(inputMethods(fixture.sendCommand)).toEqual([]);
  });

  it("keeps CSS selectors as a native-input fallback", async () => {
    const fixture = stubCdp({
      states: [elementState(), elementState({ focused: true })],
      mutations: 1,
    });

    const result = await clickPageElement(
      42,
      { kind: "selector", selector: "[data-testid=chat]", index: 0 },
    );

    expect(fixture.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 },
      "DOM.querySelectorAll",
      { nodeId: 1, selector: "[data-testid=chat]" },
    );
    expect(inputMethods(fixture.sendCommand)).toContainEqual(["Input.dispatchMouseEvent", "mousePressed"]);
    expect(result).toMatchObject({ action: "click", delivered: { method: "cdp" } });
  });

  it("uses CDP for text, key, and nested scrolling actions", async () => {
    const typedFixture = stubCdp({
      states: [elementState({ editable: true, valueLength: 0 }), elementState({ editable: true, valueLength: 5 })],
      mutations: 1,
      role: "textbox",
      name: "Message",
    });
    const typed = referencedElement("textbox", "Message");
    const typeResult = await typePageText(
      42,
      { kind: "reference", reference: typed.reference },
      "hello",
      undefined,
      typed.store,
    );
    expect(inputMethods(typedFixture.sendCommand)).toContainEqual(["Input.insertText", undefined]);
    expect(typeResult).toMatchObject({
      delivered: { method: "cdp", textLength: 5 },
      observed: { semanticChanged: true },
    });

    const keyFixture = stubCdp({
      states: [elementState({ editable: true, valueLength: 5 }), elementState({ editable: true, valueLength: 5 })],
      mutations: 2,
      role: "textbox",
      name: "Message",
    });
    const keyResult = await sendPageKey(42, "Enter", undefined, typed.store);
    expect(inputMethods(keyFixture.sendCommand)).toEqual([
      ["Input.dispatchKeyEvent", "rawKeyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
    ]);
    expect(keyResult).toMatchObject({
      delivered: { method: "cdp", key: "Enter", code: "Enter" },
      observed: { mutationCount: 2, semanticChanged: true },
    });

    const scrollFixture = stubCdp({
      states: [
        elementState({ scrollTop: 0, scrollHeight: 2400, clientHeight: 600 }),
        elementState({ scrollTop: 510, scrollHeight: 2400, clientHeight: 600 }),
      ],
      mutations: 3,
      role: "textbox",
      name: "Message",
    });
    const scrollResult = await scrollPage(42, "down", typed.reference, undefined, typed.store);
    expect(inputMethods(scrollFixture.sendCommand)).toContainEqual(["Input.dispatchMouseEvent", "mouseWheel"]);
    expect(scrollResult).toMatchObject({
      delivered: { method: "cdp", delta: { x: 0, y: 510 } },
      observed: {
        scroll: {
          before: { y: 0, maxY: 1800 },
          after: { y: 510, maxY: 1800 },
          changed: true,
        },
      },
    });
  });

  it("repeats native wheel input until a targeted scroll reaches the bottom", async () => {
    const fixture = stubCdp({
      states: [
        elementState({ scrollTop: 300, scrollHeight: 2400, clientHeight: 600 }),
        elementState({ scrollTop: 810, scrollHeight: 2400, clientHeight: 600 }),
        elementState({ scrollTop: 1320, scrollHeight: 2400, clientHeight: 600 }),
        elementState({ scrollTop: 1800, scrollHeight: 2400, clientHeight: 600 }),
      ],
    });
    const { store, reference } = referencedElement();

    const result = await scrollPage(42, "bottom", reference, undefined, store);

    expect(inputMethods(fixture.sendCommand).filter(([method]) => method === "Input.dispatchMouseEvent"))
      .toEqual([
        ["Input.dispatchMouseEvent", "mouseWheel"],
        ["Input.dispatchMouseEvent", "mouseWheel"],
        ["Input.dispatchMouseEvent", "mouseWheel"],
      ]);
    expect(result).toMatchObject({
      delivered: {
        accepted: true,
        events: 3,
        delta: { x: 0, y: 1530 },
      },
      observed: {
        status: "changed",
        scroll: {
          after: { y: 1800, maxY: 1800 },
          boundaryReached: true,
        },
      },
    });
    expect(result).not.toHaveProperty("warning");
  });

  it("observes selection-only key effects separately from delivery", async () => {
    stubCdp({
      states: [
        elementState({ editable: true, valueLength: 5 }),
        elementState({ editable: true, valueLength: 5 }),
      ],
      role: "textbox",
      name: "Message",
      selections: ["document:1:5:1:5:true", "document:1:0:1:5:false"],
    });

    const result = await sendPageKey(42, "Control+a");

    expect(result).toMatchObject({
      delivered: { accepted: true, key: "a", modifiers: ["control"] },
      observed: {
        status: "changed",
        selectionChanged: true,
        mutationCount: 0,
      },
    });
    expect(result).not.toHaveProperty("warning");
  });

  it("reports accepted key delivery when no state change is detected", async () => {
    stubCdp({
      states: [elementState({ editable: true }), elementState({ editable: true })],
      role: "textbox",
      name: "Message",
    });

    const result = await sendPageKey(42, "Backspace");

    expect(result).toMatchObject({
      delivered: { accepted: true, key: "Backspace" },
      observed: { status: "no-change-detected", semanticChanged: false },
      warning: expect.stringContaining("Chrome accepted the key input"),
    });
  });
});

function referencedElement(role = "row", name = "English"): {
  store: PageReferenceStore;
  reference: PageElementReference;
} {
  const store = new PageReferenceStore();
  const reference: PageElementReference = {
    ref: "@stest1e1",
    snapshotId: "stest1",
    tabId: 42,
    documentId: "loader-1",
    frameId: "frame-1",
    backendNodeId: 101,
    role,
    name,
  };
  store.save(reference.snapshotId, [reference]);
  return { store, reference };
}

type State = {
  connected: boolean;
  tag: string;
  focused: boolean;
  disabled: boolean;
  readOnly: boolean;
  editable: boolean;
  valueLength?: number;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
};

function elementState(overrides: Partial<State> = {}): State {
  return {
    connected: true,
    tag: "div",
    focused: false,
    disabled: false,
    readOnly: false,
    editable: false,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 300,
    scrollHeight: 60,
    clientWidth: 300,
    clientHeight: 60,
    ...overrides,
  };
}

function stubCdp(options: {
  receiverId?: number;
  relatedReceiver?: boolean;
  states?: State[];
  mutations?: number;
  role?: string;
  name?: string;
  selections?: Array<string | null>;
} = {}) {
  const receiverId = options.receiverId ?? 101;
  const states = options.states ?? [elementState(), elementState()];
  let stateIndex = 0;
  let objectIndex = 0;
  let observationIndex = 0;
  const sendCommand = vi.fn(async (
    _target: chrome.debugger.DebuggerSession,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<object> => {
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "frame-1", loaderId: "loader-1", url: "https://web.whatsapp.test/" } } };
      case "DOM.describeNode": {
        const backendNodeId = Number(params?.backendNodeId ?? params?.nodeId ?? (params?.objectId ? 101 : 101));
        const overlay = backendNodeId === 999;
        return {
          node: {
            nodeId: backendNodeId,
            backendNodeId,
            localName: overlay ? "dialog" : "div",
            nodeName: overlay ? "DIALOG" : "DIV",
            frameId: "frame-1",
            attributes: overlay ? ["role", "dialog", "aria-label", "Blocking dialog"] : ["role", "row"],
          },
        };
      }
      case "Accessibility.getPartialAXTree": {
        const backendNodeId = Number(params?.backendNodeId ?? 101);
        const overlay = backendNodeId === 999;
        return {
          nodes: [{
            backendDOMNodeId: backendNodeId,
            role: { value: overlay ? "dialog" : options.role ?? "row" },
            name: { value: overlay ? "Blocking dialog" : options.name ?? "English" },
            properties: [{ name: "focusable", value: { value: true } }],
          }],
        };
      }
      case "DOM.scrollIntoViewIfNeeded":
      case "DOM.focus":
      case "Input.dispatchMouseEvent":
      case "Input.insertText":
      case "Input.dispatchKeyEvent":
      case "Runtime.releaseObject":
        return {};
      case "DOM.getDocument":
        return { root: { nodeId: 1, backendNodeId: 1, nodeName: "#document" } };
      case "DOM.querySelectorAll":
        return { nodeIds: [101] };
      case "DOM.getContentQuads":
        return { quads: [[0, 40, 300, 40, 300, 100, 0, 100]] };
      case "DOM.getNodeForLocation":
        return { backendNodeId: receiverId, frameId: "frame-1" };
      case "DOM.resolveNode":
        objectIndex += 1;
        return { object: { objectId: `node-${objectIndex}`, subtype: "node" } };
      case "Runtime.callFunctionOn": {
        const declaration = String(params?.functionDeclaration ?? "");
        if (declaration.includes("const textInput")) {
          return { result: { objectId: "editable-node", subtype: "node" } };
        }
        if (declaration.includes("connected:")) {
          const state = states[Math.min(stateIndex, states.length - 1)]!;
          stateIndex += 1;
          return { result: { value: state } };
        }
        if (declaration.includes("this.contains(other)")) {
          return { result: { value: options.relatedReceiver ?? false } };
        }
        throw new Error(`Unexpected Runtime.callFunctionOn: ${declaration}`);
      }
      case "Runtime.evaluate": {
        const expression = String(params?.expression ?? "");
        if (expression === "document.activeElement") {
          return { result: { objectId: "active-node", subtype: "node" } };
        }
        observationIndex += 1;
        if (expression.includes("new MutationObserver")) {
          return {
            result: {
              value: {
                url: "https://web.whatsapp.test/",
                focus: { tag: "div", role: "row", name: "English" },
                mutations: 0,
                selection: options.selections?.[0] ?? null,
              },
            },
          };
        }
        if (expression.includes("record?.observer?.disconnect")) {
          return {
            result: {
              value: {
                url: "https://web.whatsapp.test/",
                focus: { tag: "div", role: "row", name: "English" },
                mutations: options.mutations ?? 0,
                selection: options.selections?.[1] ?? options.selections?.[0] ?? null,
              },
            },
          };
        }
        throw new Error(`Unexpected Runtime.evaluate #${observationIndex}: ${expression}`);
      }
      default:
        throw new Error(`Unexpected CDP command: ${method}`);
    }
  });
  const attach = vi.fn();
  const detach = vi.fn();
  vi.stubGlobal("chrome", {
    debugger: {
      attach,
      detach,
      sendCommand,
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  });
  return { sendCommand, attach, detach };
}

function inputMethods(sendCommand: ReturnType<typeof vi.fn>): Array<[string, unknown]> {
  return sendCommand.mock.calls
    .filter((call) => String(call[1]).startsWith("Input."))
    .map((call) => [String(call[1]), (call[2] as Record<string, unknown> | undefined)?.type]);
}
