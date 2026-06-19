export type TabSummary = {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  audible: boolean;
  muted: boolean;
  status: string | null;
  title: string | null;
  url: string | null;
  favIconUrl: string | null;
};

export type WindowSummary = {
  id: number;
  focused: boolean;
  type: string | null;
  state: string | null;
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
  tabIds: number[];
};

export async function listTabs(): Promise<TabSummary[]> {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number; windowId: number } =>
      typeof tab.id === "number" && typeof tab.windowId === "number"
    )
    .map(toTabSummary)
    .sort((left, right) => left.windowId - right.windowId || left.index - right.index);
}

export async function activeTab(): Promise<TabSummary | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find(hasTabIdentity);
  return tab ? toTabSummary(tab) : null;
}

export async function getTab(tabId: number): Promise<TabSummary | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return hasTabIdentity(tab) ? toTabSummary(tab) : null;
  } catch {
    return null;
  }
}

export async function createTab(url: string, active = true): Promise<TabSummary> {
  const tab = await chrome.tabs.create({ url, active });
  if (!hasTabIdentity(tab)) {
    throw new Error("Chrome did not return a tab id");
  }
  return toTabSummary(tab);
}

export async function focusTab(tabId: number): Promise<TabSummary> {
  const current = await chrome.tabs.get(tabId);
  if (typeof current.windowId === "number") {
    await chrome.windows.update(current.windowId, { focused: true });
  }
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (!tab || !hasTabIdentity(tab)) {
    throw new Error(`Unable to focus tab ${tabId}`);
  }
  return toTabSummary(tab);
}

export async function closeTab(tabId: number): Promise<void> {
  await chrome.tabs.remove(tabId);
}

export async function reloadTab(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId);
}

export async function listWindows(): Promise<WindowSummary[]> {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows
    .filter((window): window is chrome.windows.Window & { id: number } => typeof window.id === "number")
    .map((window) => ({
      id: window.id,
      focused: window.focused ?? false,
      type: window.type ?? null,
      state: window.state ?? null,
      left: typeof window.left === "number" ? window.left : null,
      top: typeof window.top === "number" ? window.top : null,
      width: typeof window.width === "number" ? window.width : null,
      height: typeof window.height === "number" ? window.height : null,
      tabIds: (window.tabs ?? [])
        .map((tab) => tab.id)
        .filter((id): id is number => typeof id === "number"),
    }))
    .sort((left, right) => left.id - right.id);
}

export async function focusWindow(windowId: number): Promise<WindowSummary> {
  const window = await chrome.windows.update(windowId, { focused: true });
  if (!window || typeof window.id !== "number") {
    throw new Error(`Unable to focus window ${windowId}`);
  }
  return {
    id: window.id,
    focused: window.focused ?? true,
    type: window.type ?? null,
    state: window.state ?? null,
    left: typeof window.left === "number" ? window.left : null,
    top: typeof window.top === "number" ? window.top : null,
    width: typeof window.width === "number" ? window.width : null,
    height: typeof window.height === "number" ? window.height : null,
    tabIds: [],
  };
}

export async function captureTabPng(tab: TabSummary): Promise<Uint8Array> {
  await focusTab(tab.id);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return dataUrlToBytes(dataUrl);
}

export async function executeInTab<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[] = [],
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return results[0]?.result as T;
}

export function toTabSummary(tab: chrome.tabs.Tab & { id: number; windowId: number }): TabSummary {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    highlighted: tab.highlighted,
    pinned: tab.pinned,
    audible: tab.audible ?? false,
    muted: tab.mutedInfo?.muted ?? false,
    status: tab.status ?? null,
    title: tab.title ?? null,
    url: tab.url ?? null,
    favIconUrl: tab.favIconUrl ?? null,
  };
}

function hasTabIdentity(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; windowId: number } {
  return typeof tab.id === "number" && typeof tab.windowId === "number";
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error("Invalid data URL");
  }
  const meta = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(meta)) {
    return new TextEncoder().encode(decodeURIComponent(data));
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
