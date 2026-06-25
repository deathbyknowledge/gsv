export type LauncherPaletteSearchItem = {
  search: string;
};

export type LauncherWindowSummary = {
  windowId: string;
  appId: string;
  title: string;
  mode: "normal" | "minimized" | "maximized";
  active: boolean;
  zIndex: number;
};

export type MobileRotorMetrics = {
  radius: number;
  depthRadius: number;
  angleStep: number;
  activeRadius: number;
};

export const MOBILE_ROTOR_MAX_VISUAL_ITEMS = 11;
export const MOBILE_ROTOR_MAX_ACTIVE_RADIUS = 4;

export function filterLauncherPaletteItems<T extends LauncherPaletteSearchItem>(
  items: readonly T[],
  query: string,
  limit = 12,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return items.slice(0, limit);
  }

  const parts = normalizedQuery.split(/\s+/g).filter(Boolean);
  return items
    .filter((item) => parts.every((part) => item.search.toLowerCase().includes(part)))
    .slice(0, limit);
}

export function normalizeMobileRotorPosition(position: number, appCount: number): number {
  if (appCount === 0) {
    return 0;
  }
  return ((position % appCount) + appCount) % appCount;
}

export function shortestMobileRotorDelta(index: number, position: number, appCount: number): number {
  if (appCount === 0) {
    return 0;
  }
  const halfCount = appCount / 2;
  return ((index - position + halfCount + appCount) % appCount) - halfCount;
}

export function centeredMobileRotorIndex(position: number, appCount: number): number {
  if (appCount === 0) {
    return -1;
  }
  return ((Math.round(position) % appCount) + appCount) % appCount;
}

export function mobileRotorMetrics(listHeight: number, appCount: number): MobileRotorMetrics | null {
  if (listHeight <= 0 || appCount <= 0) {
    return null;
  }

  return {
    radius: Math.min(Math.max(listHeight * 0.36, 190), 285),
    depthRadius: Math.min(Math.max(listHeight * 0.34, 180), 300),
    angleStep: (Math.PI * 2) / Math.min(appCount, MOBILE_ROTOR_MAX_VISUAL_ITEMS),
    activeRadius: Math.min(MOBILE_ROTOR_MAX_ACTIVE_RADIUS, Math.floor(appCount / 2)),
  };
}

export function orderMobileWindowStack<T extends LauncherWindowSummary>(
  appSummaries: readonly T[],
  selectedWindowId: string | null,
): T[] {
  return appSummaries
    .slice()
    .sort((left, right) => {
      if (selectedWindowId) {
        const leftSelected = left.windowId === selectedWindowId;
        const rightSelected = right.windowId === selectedWindowId;
        if (leftSelected !== rightSelected) {
          return leftSelected ? -1 : 1;
        }
      }

      const leftActive = left.active && left.mode !== "minimized";
      const rightActive = right.active && right.mode !== "minimized";
      if (leftActive !== rightActive) {
        return leftActive ? -1 : 1;
      }

      const leftVisible = left.mode !== "minimized";
      const rightVisible = right.mode !== "minimized";
      if (leftVisible !== rightVisible) {
        return leftVisible ? -1 : 1;
      }

      return right.zIndex - left.zIndex;
    });
}
