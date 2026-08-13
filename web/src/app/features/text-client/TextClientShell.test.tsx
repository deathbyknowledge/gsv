import type { ComponentChildren, VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StateUpdater<T> = T | ((current: T) => T);

const hooks = vi.hoisted(() => {
  let stateCursor = 0;
  let refCursor = 0;
  let state: unknown[] = [];
  let refs: Array<{ current: unknown }> = [];
  const cleanups: Array<() => void> = [];

  return {
    beginRender() {
      stateCursor = 0;
      refCursor = 0;
    },
    reset() {
      cleanups.splice(0).forEach((cleanup) => cleanup());
      stateCursor = 0;
      refCursor = 0;
      state = [];
      refs = [];
    },
    useEffect(effect: () => void | (() => void)) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = refCursor;
      refCursor += 1;
      if (!refs[index]) refs[index] = { current: initialValue };
      return refs[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, (next: StateUpdater<T>) => void] {
      const index = stateCursor;
      stateCursor += 1;
      if (!(index in state)) {
        state[index] = typeof initialValue === "function"
          ? (initialValue as () => T)()
          : initialValue;
      }
      return [state[index] as T, (next) => {
        const current = state[index] as T;
        state[index] = typeof next === "function"
          ? (next as (value: T) => T)(current)
          : next;
      }];
    },
  };
});

const fittedText = vi.hoisted(() => ({
  calls: [] as Array<{ options: unknown; text: string }>,
  policy: {
    containerRef: { current: null },
    contentHeight: 0,
    fontFamily: '"Test Fitted Prose"',
    fontSize: 42,
    lineHeight: 50,
    ready: true,
    scrolls: false,
    targetHeight: 0,
  },
}));

const listeners = vi.hoisted(() => ({
  keydown: null as ((event: KeyboardEvent) => void) | null,
}));

const chat = vi.hoisted(() => ({
  abort: vi.fn(),
  appendOptimisticUserMessage: vi.fn(),
  decide: vi.fn(),
  sendIsPending: false,
  sendMessage: vi.fn(),
  spawn: vi.fn(),
  spawnAsync: vi.fn(),
}));

vi.mock("preact/hooks", () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: hooks.useEffect,
  useLayoutEffect: hooks.useEffect,
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: hooks.useRef,
  useState: hooks.useState,
}));

vi.mock("../../services/gateway/GatewayProvider", () => ({
  useGateway: () => ({ connected: false }),
}));

vi.mock("../chat/hooks", () => ({
  useAbortChatProcess: () => ({ mutate: chat.abort }),
  useChatProcessList: () => ({ data: [{}], isLoading: false }),
  useChatRuntime: () => ({
    appendOptimisticUserMessage: chat.appendOptimisticUserMessage,
    runtime: {
      activeRunId: null,
      pendingHil: null,
      runState: "idle",
    },
  }),
  useDecideChatHil: () => ({ isPending: false, mutate: chat.decide }),
  useSendChatMessage: () => ({
    isPending: chat.sendIsPending,
    mutateAsync: chat.sendMessage,
  }),
  useSpawnChatProcess: () => ({
    isPending: false,
    mutate: chat.spawn,
    mutateAsync: chat.spawnAsync,
  }),
}));

vi.mock("../terminal/hooks/useTerminalQueries", () => ({
  useTerminalCommandMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("./model", () => ({
  chooseLatestInteractiveProcess: () => ({ pid: "proc:test" }),
  projectTextMoments: () => ({ activityLines: [], moments: [] }),
}));

vi.mock("./sound", () => ({
  createTextClientSounds: () => ({
    dispose: vi.fn(),
    play: vi.fn(),
    playTextChange: vi.fn(),
    setMuted: vi.fn(),
  }),
}));

vi.mock("./useFittedText", () => ({
  useFittedText: (text: string, options?: unknown) => {
    fittedText.calls.push({ options, text });
    return fittedText.policy;
  },
}));

import { TextClientShell } from "./TextClientShell";

type TestProps = {
  "aria-hidden"?: boolean;
  "aria-label"?: string;
  children?: ComponentChildren;
  class?: string;
  currentId?: string | null;
  disabled?: boolean;
  items?: unknown[];
  oninput?: (event: { currentTarget: { value: string } }) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  style?: Record<string, string>;
  type?: string;
  value?: string;
};

type TestNode = VNode<TestProps>;

class FakeElement {
  readonly focus = vi.fn();

  constructor(
    readonly tagName: string,
    readonly parentElement: FakeElement | null = null,
    readonly attributes: Record<string, string> = {},
  ) {}

  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const candidate = part.trim();
      if (candidate === this.tagName) return true;
      const attribute = candidate.match(/^\[([^=]+)=([^\]]+)\]$/);
      return attribute
        ? this.attributes[attribute[1]] === attribute[2]
        : false;
    });
  }

  closest(selector: string): FakeElement | null {
    let candidate: FakeElement | null = this;
    while (candidate) {
      if (candidate.matches(selector)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }
}

class FakeTextarea extends FakeElement {
  value = "";

  constructor() {
    super("textarea");
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function collectNodes(value: ComponentChildren): TestNode[] {
  const nodes: TestNode[] = [];
  const visit = (child: ComponentChildren): void => {
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    if (!child || typeof child !== "object" || !("props" in child)) return;
    const node = child as TestNode;
    nodes.push(node);
    visit(node.props.children);
  };
  visit(value);
  return nodes;
}

function renderShell(): TestNode {
  hooks.beginRender();
  return TextClientShell({ username: "test", onLock: vi.fn() });
}

function printableKey(target: FakeElement, key = "x") {
  const preventDefault = vi.fn();
  const event = {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key,
    metaKey: false,
    preventDefault,
    target,
    composedPath: () => {
      const path: FakeElement[] = [];
      let candidate: FakeElement | null = target;
      while (candidate) {
        path.push(candidate);
        candidate = candidate.parentElement;
      }
      return path;
    },
  } as unknown as KeyboardEvent;
  listeners.keydown?.(event);
  return { event, preventDefault };
}

function textareaNode(root: TestNode): TestNode {
  const textarea = collectNodes(root).find((node) => node.type === "textarea");
  expect(textarea, "expected the persistent draft textarea to be mounted").toBeDefined();
  return textarea as TestNode;
}

function mountTextarea(node: TestNode, textarea: FakeTextarea): void {
  if (typeof node.ref === "function") {
    node.ref(textarea as unknown as HTMLTextAreaElement);
  } else if (node.ref) {
    node.ref.current = textarea as unknown as HTMLTextAreaElement;
  } else {
    throw new Error("The persistent draft textarea needs a focusable ref");
  }
}

function draftNodes(root: TestNode): TestNode[] {
  const draft = draftNode(root);
  expect(draft, "expected the persistent draft surface to be mounted").toBeDefined();
  return collectNodes(draft);
}

function draftNode(root: TestNode): TestNode | undefined {
  return collectNodes(root).find((node) => (
    node.props.class?.split(" ").includes("text-client-draft")
  ));
}

function currentMomentId(root: TestNode): string | null | undefined {
  return collectNodes(root).find((node) => Array.isArray(node.props.items))?.props.currentId;
}

function inputDraft(node: TestNode, textarea: FakeTextarea, value: string): void {
  textarea.value = value;
  expect(node.props.oninput).toBeTypeOf("function");
  node.props.oninput?.({ currentTarget: textarea });
}

function composerKey(
  node: TestNode,
  key: string,
  options: { isComposing?: boolean; keyCode?: number } = {},
) {
  const preventDefault = vi.fn();
  node.props.onKeyDown?.({
    ctrlKey: false,
    isComposing: options.isComposing ?? false,
    key,
    keyCode: options.keyCode ?? 0,
    metaKey: false,
    preventDefault,
    shiftKey: false,
  } as unknown as KeyboardEvent);
  return { preventDefault };
}

beforeEach(() => {
  hooks.reset();
  fittedText.calls = [];
  listeners.keydown = null;
  chat.abort.mockReset();
  chat.appendOptimisticUserMessage.mockReset();
  chat.decide.mockReset();
  chat.sendIsPending = false;
  chat.sendMessage.mockReset().mockResolvedValue(undefined);
  chat.spawn.mockReset();
  chat.spawnAsync.mockReset().mockResolvedValue({ pid: "proc:spawned" });
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextarea);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      if (type === "keydown") listeners.keydown = listener;
    },
    clearTimeout: vi.fn(),
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      if (type === "keydown" && listeners.keydown === listener) listeners.keydown = null;
    },
    setTimeout: vi.fn(() => 1),
  });
});

afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
});

describe("TextClientShell draft capture", () => {
  it("focuses the persistent draft for printable keys from non-editable descendants", () => {
    const initial = renderShell();
    expect(draftNode(initial)?.props["aria-hidden"]).not.toBe(true);
    const textarea = new FakeTextarea();
    mountTextarea(textareaNode(initial), textarea);
    const article = new FakeElement("article");
    const nestedCopy = new FakeElement("span", article);

    const { preventDefault } = printableKey(nestedCopy, "q");

    expect(textarea.focus).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
    const focused = renderShell();
    expect(textareaNode(focused).props.value).toBe("");
    expect(currentMomentId(focused)).not.toBe("draft");

    inputDraft(textareaNode(focused), textarea, "q");
    const typed = renderShell();
    expect(textareaNode(typed).props.value).toBe("q");
    expect(currentMomentId(typed)).toBe("draft");
  });

  it.each([
    ["button", "button", {}],
    ["link", "a", {}],
    ["role=button", "div", { role: "button" }],
    ["contenteditable", "div", { contenteditable: "true" }],
  ])(
    "leaves printable keys on descendants of %s controls untouched",
    (_label, tagName, attributes) => {
      const initial = renderShell();
      const textarea = new FakeTextarea();
      mountTextarea(textareaNode(initial), textarea);
      const control = new FakeElement(tagName, null, attributes);
      const nestedLabel = new FakeElement("span", control);

      const { preventDefault } = printableKey(nestedLabel);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(textarea.focus).not.toHaveBeenCalled();
      expect(textareaNode(renderShell()).props.value).toBe("");
    },
  );

  it("uses Enter as the draft commit affordance without rendering a send button", () => {
    const initial = renderShell();
    const textarea = new FakeTextarea();
    const composer = textareaNode(initial);
    mountTextarea(composer, textarea);
    inputDraft(composer, textarea, "draft");

    const nodes = draftNodes(renderShell());

    expect(nodes.some((node) => node.type === "button")).toBe(false);
  });

  it("reveals a preserved hidden draft on Enter before allowing a send", () => {
    renderShell();
    const initial = renderShell();
    const textarea = new FakeTextarea();
    const composer = textareaNode(initial);
    mountTextarea(composer, textarea);
    inputDraft(composer, textarea, "held draft");
    const visible = renderShell();

    composerKey(textareaNode(visible), "Escape");
    const hidden = renderShell();
    expect(textareaNode(hidden).props.value).toBe("held draft");
    expect(currentMomentId(hidden)).not.toBe("draft");

    const firstEnter = composerKey(textareaNode(hidden), "Enter");
    const revealed = renderShell();

    expect(firstEnter.preventDefault).toHaveBeenCalledOnce();
    expect(currentMomentId(revealed)).toBe("draft");
    expect(textareaNode(revealed).props.value).toBe("held draft");
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("preserves native input text exactly through submission", async () => {
    renderShell();
    const initial = renderShell();
    const textarea = new FakeTextarea();
    const composer = textareaNode(initial);
    mountTextarea(composer, textarea);
    const raw = "  pasted before\nafter  ";

    inputDraft(composer, textarea, raw);
    const visible = renderShell();

    expect(textareaNode(visible).props.value).toBe(raw);
    composerKey(textareaNode(visible), "Enter");
    expect(chat.appendOptimisticUserMessage).toHaveBeenCalledWith(raw);
    expect(chat.sendMessage).toHaveBeenCalledWith({
      message: raw,
      pid: "proc:test",
    });
    await Promise.resolve();
  });

  it("applies the fitted moment typography policy to the draft", () => {
    const initial = renderShell();
    const textarea = new FakeTextarea();
    const initialComposer = textareaNode(initial);
    mountTextarea(initialComposer, textarea);
    inputDraft(initialComposer, textarea, "t");

    const typed = textareaNode(renderShell());

    expect(fittedText.calls.some((call) => call.text === "t")).toBe(true);
    expect(typed.props.style).toMatchObject({
      fontFamily: fittedText.policy.fontFamily,
      fontSize: `${fittedText.policy.fontSize}px`,
      lineHeight: `${fittedText.policy.lineHeight}px`,
    });
  });

  it("keeps composition-owned Enter and Escape inside the textarea", () => {
    const initial = renderShell();
    const textarea = new FakeTextarea();
    const initialComposer = textareaNode(initial);
    mountTextarea(initialComposer, textarea);
    inputDraft(initialComposer, textarea, "composing");
    const visible = renderShell();
    const visibleComposer = textareaNode(visible);

    for (const { isComposing, key, keyCode } of [
      { isComposing: true, key: "Enter", keyCode: 13 },
      { isComposing: true, key: "Escape", keyCode: 27 },
      { isComposing: false, key: "Enter", keyCode: 229 },
      { isComposing: false, key: "Escape", keyCode: 229 },
    ]) {
      const { preventDefault } = composerKey(visibleComposer, key, { isComposing, keyCode });
      expect(preventDefault).not.toHaveBeenCalled();
    }

    const afterComposition = renderShell();
    expect(textareaNode(afterComposition).props.value).toBe("composing");
    expect(currentMomentId(afterComposition)).toBe("draft");
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the editor enabled and preserves newer input when a send fails", async () => {
    renderShell();
    const initial = renderShell();
    const textarea = new FakeTextarea();
    const composer = textareaNode(initial);
    mountTextarea(composer, textarea);
    inputDraft(composer, textarea, "submitted draft");
    const visible = renderShell();
    const pendingSend = deferred<void>();
    chat.sendMessage.mockReturnValueOnce(pendingSend.promise);

    composerKey(textareaNode(visible), "Enter");
    chat.sendIsPending = true;
    const pending = renderShell();

    expect(textareaNode(pending).props.disabled).not.toBe(true);
    inputDraft(textareaNode(pending), textarea, "newer draft");
    expect(textareaNode(renderShell()).props.value).toBe("newer draft");

    pendingSend.reject(new Error("send failed"));
    await Promise.resolve();
    chat.sendIsPending = false;
    const failed = renderShell();

    expect(textareaNode(failed).props.value).toBe("newer draft");
    expect(currentMomentId(failed)).toBe("draft");
  });
});
