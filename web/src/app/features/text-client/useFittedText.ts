import { layout, prepare, type PreparedText } from "@chenglou/pretext";
import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

export const FITTED_TEXT_FONT_FAMILY = '"Space Grotesk"';
export const FITTED_TEXT_MIN_SIZE = 24;
export const FITTED_TEXT_MAX_SIZE = 54;
export const FITTED_TEXT_SIZE_STEP = 2;
export const FITTED_TEXT_HEIGHT_TARGET = 0.78;

const FITTED_TEXT_FONT_WEIGHT = 400;
const FITTED_TEXT_LINE_HEIGHT_RATIO = 1.18;
const PREPARED_TEXT_CACHE_LIMIT = 256;
const HEIGHT_TOLERANCE = 0.5;

export interface FittedTextViewport {
  width: number;
  height: number;
}

export interface FittedTextPolicy {
  fontSize: number;
  lineHeight: number;
  contentHeight: number;
  targetHeight: number;
  scrolls: boolean;
}

export interface ChooseFittedTextPolicyOptions {
  candidates: readonly number[];
  availableHeight: number;
  measureHeight: (fontSize: number, lineHeight: number) => number;
  lockedSize?: number | null;
}

export interface UseFittedTextOptions {
  /** Freeze the most recently fitted size until `locked` becomes false. */
  locked?: boolean;
  /**
   * Force a caller-owned stable size. This takes precedence over `locked` and
   * is clamped and quantized to the fitted-prose scale.
   */
  lockedSize?: number | null;
}

export interface UseFittedTextResult<T extends HTMLElement> extends FittedTextPolicy {
  /** Attach this to the stable viewport that contains the prose. */
  containerRef: RefObject<T>;
  fontFamily: typeof FITTED_TEXT_FONT_FAMILY;
  ready: boolean;
}

interface ElementSize {
  width: number;
  height: number;
}

interface FittedTextState extends FittedTextPolicy {
  ready: boolean;
}

const preparedTextCache = new Map<string, PreparedText>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Clamp a font size to the prose scale and place it on the 2px grid. */
export function quantizeFittedTextSize(value: number): number {
  const finiteValue = Number.isFinite(value) ? value : FITTED_TEXT_MIN_SIZE;
  const quantized = Math.round(finiteValue / FITTED_TEXT_SIZE_STEP) * FITTED_TEXT_SIZE_STEP;
  return clamp(quantized, FITTED_TEXT_MIN_SIZE, FITTED_TEXT_MAX_SIZE);
}

export function fittedTextLineHeight(fontSize: number): number {
  return Math.round(quantizeFittedTextSize(fontSize) * FITTED_TEXT_LINE_HEIGHT_RATIO);
}

/**
 * Build the descending fitted-prose scale for a viewport. The ceiling follows
 * the smaller of 9vw and 7vh, then the absolute 24–54px bounds take over.
 */
export function fittedTextCandidates(viewport: FittedTextViewport): number[] {
  const width = finiteDimension(viewport.width);
  const height = finiteDimension(viewport.height);
  const responsiveCeiling = Math.min(width * 0.09, height * 0.07);
  const clampedCeiling = clamp(
    responsiveCeiling,
    FITTED_TEXT_MIN_SIZE,
    FITTED_TEXT_MAX_SIZE,
  );
  const ceiling = clamp(
    Math.floor(clampedCeiling / FITTED_TEXT_SIZE_STEP) * FITTED_TEXT_SIZE_STEP,
    FITTED_TEXT_MIN_SIZE,
    FITTED_TEXT_MAX_SIZE,
  );
  const candidates: number[] = [];

  for (let size = ceiling; size >= FITTED_TEXT_MIN_SIZE; size -= FITTED_TEXT_SIZE_STEP) {
    candidates.push(size);
  }

  return candidates;
}

function normalizedCandidates(candidates: readonly number[]): number[] {
  const sizes = new Set<number>();
  for (const candidate of candidates) {
    sizes.add(quantizeFittedTextSize(candidate));
  }
  sizes.add(FITTED_TEXT_MIN_SIZE);
  return [...sizes].sort((left, right) => right - left);
}

/**
 * Choose the largest candidate whose measured text occupies no more than 78%
 * of the available height. If even 24px misses that target, the policy keeps
 * the floor and asks the viewport to scroll.
 */
export function chooseFittedTextPolicy({
  candidates,
  availableHeight,
  measureHeight,
  lockedSize,
}: ChooseFittedTextPolicyOptions): FittedTextPolicy {
  const targetHeight = finiteDimension(availableHeight) * FITTED_TEXT_HEIGHT_TARGET;
  const sizes = lockedSize == null
    ? normalizedCandidates(candidates)
    : [quantizeFittedTextSize(lockedSize)];
  let smallestPolicy: FittedTextPolicy | null = null;

  for (const fontSize of sizes) {
    const lineHeight = fittedTextLineHeight(fontSize);
    const measuredHeight = measureHeight(fontSize, lineHeight);
    const contentHeight = Number.isFinite(measuredHeight)
      ? Math.max(0, measuredHeight)
      : Number.POSITIVE_INFINITY;
    const fits = contentHeight <= targetHeight + HEIGHT_TOLERANCE;
    const policy = {
      fontSize,
      lineHeight,
      contentHeight,
      targetHeight,
      scrolls: !fits,
    };

    if (fits || lockedSize != null) {
      return policy;
    }
    smallestPolicy = policy;
  }

  return smallestPolicy ?? {
    fontSize: FITTED_TEXT_MIN_SIZE,
    lineHeight: fittedTextLineHeight(FITTED_TEXT_MIN_SIZE),
    contentHeight: Number.POSITIVE_INFINITY,
    targetHeight,
    scrolls: true,
  };
}

function fontShorthand(fontSize: number): string {
  return `${FITTED_TEXT_FONT_WEIGHT} ${fontSize}px ${FITTED_TEXT_FONT_FAMILY}`;
}

function prepareCached(text: string, font: string): PreparedText {
  const cacheKey = JSON.stringify([text, font]);
  const cached = preparedTextCache.get(cacheKey);
  if (cached) {
    preparedTextCache.delete(cacheKey);
    preparedTextCache.set(cacheKey, cached);
    return cached;
  }

  const prepared = prepare(text, font);
  preparedTextCache.set(cacheKey, prepared);
  if (preparedTextCache.size > PREPARED_TEXT_CACHE_LIMIT) {
    const oldestKey = preparedTextCache.keys().next().value;
    if (oldestKey !== undefined) {
      preparedTextCache.delete(oldestKey);
    }
  }
  return prepared;
}

function sameElementSize(left: ElementSize, right: ElementSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function sameFittedTextState(left: FittedTextState, right: FittedTextState): boolean {
  return left.ready === right.ready
    && left.fontSize === right.fontSize
    && left.lineHeight === right.lineHeight
    && left.contentHeight === right.contentHeight
    && left.targetHeight === right.targetHeight
    && left.scrolls === right.scrolls;
}

function currentViewport(fallback: ElementSize): FittedTextViewport {
  if (typeof window === "undefined") {
    return fallback;
  }
  return {
    width: finiteDimension(window.innerWidth) || fallback.width,
    height: finiteDimension(window.innerHeight) || fallback.height,
  };
}

const INITIAL_STATE: FittedTextState = {
  fontSize: FITTED_TEXT_MIN_SIZE,
  lineHeight: fittedTextLineHeight(FITTED_TEXT_MIN_SIZE),
  contentHeight: 0,
  targetHeight: 0,
  scrolls: false,
  ready: false,
};

/**
 * Fit native-style Space Grotesk prose to a stable container. Pretext remains
 * an implementation detail here: prepared handles never cross this boundary.
 */
export function useFittedText<T extends HTMLElement = HTMLDivElement>(
  text: string,
  options: UseFittedTextOptions = {},
): UseFittedTextResult<T> {
  const containerRef = useRef<T>(null);
  const [containerSize, setContainerSize] = useState<ElementSize>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<FittedTextViewport>({ width: 0, height: 0 });
  const [fontsReady, setFontsReady] = useState(false);
  const [state, setState] = useState<FittedTextState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const internallyLockedSizeRef = useRef<number | null>(null);
  const locked = options.locked ?? false;
  const callerLockedSize = options.lockedSize;

  useLayoutEffect(() => {
    const fontSet = typeof document === "undefined" ? undefined : document.fonts;
    if (!fontSet) {
      setFontsReady(true);
      return;
    }

    let cancelled = false;
    setFontsReady(false);
    Promise.all([
      fontSet.load(fontShorthand(FITTED_TEXT_MAX_SIZE)),
      fontSet.ready,
    ]).then(
      () => {
        if (!cancelled) {
          setFontsReady(true);
        }
      },
      () => {
        // A font-loading failure must not strand the reading surface. Pretext
        // can still measure the browser's named-font fallback.
        if (!cancelled) {
          setFontsReady(true);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const commitSize = (nextSize: ElementSize) => {
      const normalized = {
        width: finiteDimension(nextSize.width),
        height: finiteDimension(nextSize.height),
      };
      setContainerSize((previous) => sameElementSize(previous, normalized) ? previous : normalized);
      const nextViewport = currentViewport(normalized);
      setViewport((previous) => sameElementSize(previous, nextViewport) ? previous : nextViewport);
    };
    const measureElement = () => {
      commitSize({ width: element.clientWidth, height: element.clientHeight });
    };
    const measureViewport = () => {
      measureElement();
    };

    measureElement();
    window.addEventListener("resize", measureViewport);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", measureViewport);
      };
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        commitSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureViewport);
    };
  }, []);

  useLayoutEffect(() => {
    if (!fontsReady || containerSize.width <= 0 || containerSize.height <= 0) {
      return;
    }

    if (!locked) {
      internallyLockedSizeRef.current = null;
    }
    const stableSize = callerLockedSize != null
      ? callerLockedSize
      : locked
        ? internallyLockedSizeRef.current ?? (stateRef.current.ready ? stateRef.current.fontSize : null)
        : null;
    const candidates = fittedTextCandidates(viewport);
    let nextPolicy: FittedTextPolicy;

    try {
      nextPolicy = chooseFittedTextPolicy({
        candidates,
        availableHeight: containerSize.height,
        lockedSize: stableSize,
        measureHeight: (fontSize, lineHeight) => {
          if (text.length === 0) {
            return 0;
          }
          const prepared = prepareCached(text, fontShorthand(fontSize));
          return layout(prepared, containerSize.width, lineHeight).height;
        },
      });
    } catch {
      // Unsupported segmentation/canvas APIs degrade to readable scrolling
      // prose instead of taking down the entire text client.
      const fallbackSize = stableSize == null
        ? FITTED_TEXT_MIN_SIZE
        : quantizeFittedTextSize(stableSize);
      nextPolicy = {
        fontSize: fallbackSize,
        lineHeight: fittedTextLineHeight(fallbackSize),
        contentHeight: Number.POSITIVE_INFINITY,
        targetHeight: containerSize.height * FITTED_TEXT_HEIGHT_TARGET,
        scrolls: true,
      };
    }

    if (locked && callerLockedSize == null && internallyLockedSizeRef.current == null) {
      internallyLockedSizeRef.current = nextPolicy.fontSize;
    }
    const nextState = { ...nextPolicy, ready: true };
    stateRef.current = nextState;
    setState((previous) => sameFittedTextState(previous, nextState) ? previous : nextState);
  }, [callerLockedSize, containerSize, fontsReady, locked, text, viewport]);

  return {
    containerRef,
    fontFamily: FITTED_TEXT_FONT_FAMILY,
    ...state,
  };
}
