import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

export type VirtualTranscriptSource = {
  alwaysRender?: boolean;
  estimateHeight: number;
  estimateKey?: string;
  key: string;
};

export type VirtualTranscriptItem<T extends VirtualTranscriptSource> = {
  bottom: number;
  entry: T;
  height: number;
  index: number;
  top: number;
};

const TRANSCRIPT_ITEM_GAP = 14;
const TRANSCRIPT_OVERSCAN_PX = 900;
const HEIGHT_EPSILON = 0.5;

type CachedHeight = {
  estimateKey: string;
  height: number;
};

export function useVirtualTranscript<T extends VirtualTranscriptSource>({
  entries,
  scrollTop,
  viewportHeight,
}: {
  entries: T[];
  scrollTop: number;
  viewportHeight: number;
}) {
  const heightCacheRef = useRef<Map<string, CachedHeight>>(new Map());
  const observersRef = useRef<Map<string, ResizeObserver>>(new Map());
  const nodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);
  const entryKey = useMemo(() => entries.map((entry) => entry.key).join("\n"), [entries]);

  const geometry = useMemo(() => {
    const items: Array<VirtualTranscriptItem<T>> = [];
    let cursor = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as T;
      const entryEstimateKey = estimateKeyForEntry(entry);
      const cached = heightCacheRef.current.get(entry.key);
      const cachedHeight = cached?.estimateKey === entryEstimateKey ? cached.height : undefined;
      const height = Math.max(1, cachedHeight ?? entry.estimateHeight);
      const top = cursor;
      const bottom = top + height;
      items.push({ bottom, entry, height, index, top });
      cursor = bottom + (index === entries.length - 1 ? 0 : TRANSCRIPT_ITEM_GAP);
    }
    return {
      items,
      totalHeight: cursor,
    };
  }, [entries, entryKey, measureVersion]);

  const visibleItems = useMemo(() => {
    const minY = Math.max(0, scrollTop - TRANSCRIPT_OVERSCAN_PX);
    const maxY = scrollTop + Math.max(1, viewportHeight) + TRANSCRIPT_OVERSCAN_PX;
    return geometry.items.filter((item) => (
      item.entry.alwaysRender === true || (item.bottom >= minY && item.top <= maxY)
    ));
  }, [geometry, scrollTop, viewportHeight]);

  const setItemNode = useCallback((key: string, estimateKey: string, node: HTMLElement | null) => {
    const priorObserver = observersRef.current.get(key);
    if (priorObserver) {
      priorObserver.disconnect();
      observersRef.current.delete(key);
    }
    nodesRef.current.delete(key);

    if (!node) {
      return;
    }

    nodesRef.current.set(key, node);
    const updateHeight = () => {
      const nextHeight = node.offsetHeight;
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
        return;
      }
      const currentHeight = heightCacheRef.current.get(key);
      if (
        currentHeight?.estimateKey === estimateKey &&
        Math.abs(currentHeight.height - nextHeight) < HEIGHT_EPSILON
      ) {
        return;
      }
      heightCacheRef.current.set(key, { estimateKey, height: nextHeight });
      setMeasureVersion((version) => version + 1);
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    observersRef.current.set(key, observer);
  }, []);

  useEffect(() => {
    const keys = new Set(entries.map((entry) => entry.key));
    for (const key of Array.from(heightCacheRef.current.keys())) {
      if (!keys.has(key)) {
        heightCacheRef.current.delete(key);
      }
    }
    for (const [key, observer] of Array.from(observersRef.current.entries())) {
      if (!keys.has(key)) {
        observer.disconnect();
        observersRef.current.delete(key);
        nodesRef.current.delete(key);
      }
    }
  }, [entries, entryKey]);

  useEffect(() => () => {
    for (const observer of observersRef.current.values()) {
      observer.disconnect();
    }
    observersRef.current.clear();
    nodesRef.current.clear();
  }, []);

  return {
    gap: TRANSCRIPT_ITEM_GAP,
    items: visibleItems,
    setItemNode,
    totalHeight: geometry.totalHeight,
  };
}

function estimateKeyForEntry(entry: VirtualTranscriptSource): string {
  return entry.estimateKey ?? String(Math.round(entry.estimateHeight));
}
