import { sendDebuggerCommand } from "../shared/debugger";

type LayoutMetricsResult = {
  visualViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
  layoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
  contentSize?: {
    width?: number;
    height?: number;
  };
};

export type PageScrollTarget = "up" | "down" | "top" | "bottom" | { x: number; y: number };

export type ScrollState = {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
};

export type PageScrollState = ScrollState;

export type InputPoint = {
  x: number;
  y: number;
};

export type ParsedKey = {
  key: string;
  code: string;
  modifiers: number;
  modifierNames: string[];
  windowsVirtualKeyCode: number;
  text?: string;
};

export function parsePageKey(raw: string): ParsedKey {
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  const keyPart = parts.pop() ?? "";
  if (!keyPart) {
    throw new Error("Key is required");
  }
  const modifierNames = parts.map((part) => part.toLowerCase());
  let modifiers = 0;
  for (const modifier of modifierNames) {
    if (modifier === "alt" || modifier === "option") modifiers |= 1;
    else if (modifier === "ctrl" || modifier === "control") modifiers |= 2;
    else if (modifier === "meta" || modifier === "cmd" || modifier === "command") modifiers |= 4;
    else if (modifier === "shift") modifiers |= 8;
    else throw new Error(`Unknown key modifier: ${modifier}`);
  }
  const normalized = keyPart.toLowerCase();
  const named: Record<string, { key: string; code: string; virtual: number }> = {
    backspace: { key: "Backspace", code: "Backspace", virtual: 8 },
    tab: { key: "Tab", code: "Tab", virtual: 9 },
    enter: { key: "Enter", code: "Enter", virtual: 13 },
    return: { key: "Enter", code: "Enter", virtual: 13 },
    escape: { key: "Escape", code: "Escape", virtual: 27 },
    esc: { key: "Escape", code: "Escape", virtual: 27 },
    space: { key: " ", code: "Space", virtual: 32 },
    pageup: { key: "PageUp", code: "PageUp", virtual: 33 },
    pagedown: { key: "PageDown", code: "PageDown", virtual: 34 },
    end: { key: "End", code: "End", virtual: 35 },
    home: { key: "Home", code: "Home", virtual: 36 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", virtual: 37 },
    left: { key: "ArrowLeft", code: "ArrowLeft", virtual: 37 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", virtual: 38 },
    up: { key: "ArrowUp", code: "ArrowUp", virtual: 38 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", virtual: 39 },
    right: { key: "ArrowRight", code: "ArrowRight", virtual: 39 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", virtual: 40 },
    down: { key: "ArrowDown", code: "ArrowDown", virtual: 40 },
    delete: { key: "Delete", code: "Delete", virtual: 46 },
  };
  const mapped = named[normalized];
  if (mapped) {
    return { ...mapped, windowsVirtualKeyCode: mapped.virtual, modifiers, modifierNames };
  }
  if (keyPart.length !== 1) {
    throw new Error(`Unsupported key: ${keyPart}`);
  }
  const upper = keyPart.toUpperCase();
  return {
    key: keyPart,
    code: /[a-z]/i.test(keyPart) ? `Key${upper}` : keyPart,
    modifiers,
    modifierNames,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    ...(modifiers & (1 | 2 | 4) ? {} : { text: keyPart }),
  };
}

export function keyEvent(direction: "down" | "up", key: ParsedKey): Record<string, unknown> {
  return {
    type: direction === "up" ? "keyUp" : key.text ? "keyDown" : "rawKeyDown",
    key: key.key,
    code: key.code,
    modifiers: key.modifiers,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode,
    nativeVirtualKeyCode: key.windowsVirtualKeyCode,
    ...(direction === "down" && key.text ? { text: key.text, unmodifiedText: key.text } : {}),
  };
}

export async function readPageScrollState(
  target: chrome.debugger.DebuggerSession,
): Promise<PageScrollState> {
  const metrics = await sendDebuggerCommand<LayoutMetricsResult>(target, "Page.getLayoutMetrics");
  const viewport = metrics.visualViewport ?? metrics.layoutViewport ?? {};
  return {
    scrollLeft: viewport.pageX ?? 0,
    scrollTop: viewport.pageY ?? 0,
    scrollWidth: metrics.contentSize?.width ?? viewport.clientWidth ?? 0,
    scrollHeight: metrics.contentSize?.height ?? viewport.clientHeight ?? 0,
    clientWidth: viewport.clientWidth ?? 0,
    clientHeight: viewport.clientHeight ?? 0,
  };
}

export async function viewportCenter(target: chrome.debugger.DebuggerSession): Promise<InputPoint> {
  const state = await readPageScrollState(target);
  return {
    x: Math.max(1, state.clientWidth / 2),
    y: Math.max(1, state.clientHeight / 2),
  };
}

export function scrollDeltas(target: PageScrollTarget, state: ScrollState): InputPoint {
  const maxY = Math.max(0, state.scrollHeight - state.clientHeight);
  if (typeof target === "object") {
    return { x: target.x - state.scrollLeft, y: target.y - state.scrollTop };
  }
  const pageY = Math.max(1, Math.floor(state.clientHeight * 0.85));
  switch (target) {
    case "up":
      return { x: 0, y: -pageY };
    case "down":
      return { x: 0, y: pageY };
    case "top":
      return { x: 0, y: -Math.max(pageY, maxY) };
    case "bottom":
      return { x: 0, y: Math.max(pageY, maxY) };
  }
}

export function scrollChanged(before: ScrollState, after: ScrollState | null): boolean {
  return Boolean(after)
    && (Math.round(before.scrollLeft) !== Math.round(after!.scrollLeft)
      || Math.round(before.scrollTop) !== Math.round(after!.scrollTop));
}

export function scrollSummary(state: ScrollState | null): Record<string, number> | null {
  if (!state) {
    return null;
  }
  return {
    x: Math.round(state.scrollLeft),
    y: Math.round(state.scrollTop),
    maxX: Math.max(0, Math.round(state.scrollWidth - state.clientWidth)),
    maxY: Math.max(0, Math.round(state.scrollHeight - state.clientHeight)),
  };
}
