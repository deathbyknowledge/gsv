export type DesktopWindowMode = "normal" | "minimized" | "maximized";
export type DesktopVisibleWindowMode = Exclude<DesktopWindowMode, "minimized">;

export type PersistedDesktopWindow = {
  appId: string;
  route?: string;
  title?: string;
  mode: DesktopWindowMode;
  lastVisibleMode: DesktopVisibleWindowMode;
  x: number;
  y: number;
  width: number;
  height: number;
  restoreX: number;
  restoreY: number;
  restoreWidth: number;
  restoreHeight: number;
  zIndex: number;
};

export type PersistedDesktopLayout = {
  version: 1;
  activeAppId: string | null;
  windows: PersistedDesktopWindow[];
};

export type SerializableDesktopWindow = {
  windowId: string;
  appId: string;
  appName: string;
  route: string;
  title: string;
  mode: DesktopWindowMode;
  lastVisibleMode: DesktopVisibleWindowMode;
  x: number;
  y: number;
  width: number;
  height: number;
  restoreX: number;
  restoreY: number;
  restoreWidth: number;
  restoreHeight: number;
  zIndex: number;
  persist: boolean;
};

export type RestoredDesktopWindowCandidate = {
  windowId: string;
  appId: string;
  mode: DesktopWindowMode;
  zIndex: number;
};

const LAYOUT_STORAGE_KEY = "gsv.desktop.layout.v1";

function isDesktopWindowMode(value: unknown): value is DesktopWindowMode {
  return value === "normal" || value === "minimized" || value === "maximized";
}

function isDesktopVisibleWindowMode(value: unknown): value is DesktopVisibleWindowMode {
  return value === "normal" || value === "maximized";
}

function isPersistedDesktopWindow(value: unknown): value is PersistedDesktopWindow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<PersistedDesktopWindow>;
  return (
    typeof item.appId === "string" &&
    isDesktopWindowMode(item.mode) &&
    isDesktopVisibleWindowMode(item.lastVisibleMode) &&
    typeof item.x === "number" &&
    typeof item.y === "number" &&
    typeof item.width === "number" &&
    typeof item.height === "number" &&
    typeof item.restoreX === "number" &&
    typeof item.restoreY === "number" &&
    typeof item.restoreWidth === "number" &&
    typeof item.restoreHeight === "number" &&
    typeof item.zIndex === "number"
  );
}

export function readPersistedDesktopLayout(): PersistedDesktopLayout | null {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedDesktopLayout>;
    if (parsed.version !== 1 || !Array.isArray(parsed.windows)) {
      return null;
    }

    return {
      version: 1,
      activeAppId: typeof parsed.activeAppId === "string" ? parsed.activeAppId : null,
      windows: parsed.windows.filter(isPersistedDesktopWindow),
    };
  } catch {
    return null;
  }
}

export function writePersistedDesktopLayout(layout: PersistedDesktopLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Ignore storage failures and keep runtime behavior.
  }
}

export function serializeDesktopLayout(
  records: Iterable<SerializableDesktopWindow>,
  activeWindowId: string | null,
): PersistedDesktopLayout {
  const ordered = [...records].sort((left, right) => left.zIndex - right.zIndex);
  const persistent = ordered.filter((record) => record.persist);
  const activeRecord = activeWindowId
    ? persistent.find((record) => record.windowId === activeWindowId) ?? null
    : null;

  return {
    version: 1,
    activeAppId: activeRecord?.appId ?? null,
    windows: persistent.map((record) => ({
      appId: record.appId,
      route: record.route,
      title: record.title === record.appName ? undefined : record.title,
      mode: record.mode,
      lastVisibleMode: record.lastVisibleMode,
      x: record.x,
      y: record.y,
      width: record.width,
      height: record.height,
      restoreX: record.restoreX,
      restoreY: record.restoreY,
      restoreWidth: record.restoreWidth,
      restoreHeight: record.restoreHeight,
      zIndex: record.zIndex,
    })),
  };
}

export function selectRestoredActiveWindowId(
  candidates: Iterable<RestoredDesktopWindowCandidate>,
  activeAppId: string | null,
  fallbackWindowId: string | null,
): string | null {
  const visible = [...candidates].filter((record) => record.mode !== "minimized");

  if (activeAppId) {
    const activeRecord = visible
      .filter((record) => record.appId === activeAppId)
      .sort((left, right) => right.zIndex - left.zIndex)[0];
    if (activeRecord) {
      return activeRecord.windowId;
    }
  }

  if (fallbackWindowId) {
    return fallbackWindowId;
  }

  return visible.sort((left, right) => right.zIndex - left.zIndex)[0]?.windowId ?? null;
}
