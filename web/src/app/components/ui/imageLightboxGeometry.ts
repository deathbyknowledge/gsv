/** Pure geometry for ImageLightbox. The stage renders the image centred and
 *  transformed as `translate(offset) scale(scale)` about its centre, so every
 *  coordinate here is relative to the stage centre (positive x right, positive
 *  y down) and independent of the DOM. */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** One wheel notch / button press. */
export const ZOOM_STEP = 1.35;
/** Where a click on the photo lands when zooming in from the fitted view. */
export const CLICK_ZOOM = 2.5;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export function clampZoom(scale: number): number {
  // Only NaN falls back to fit — a runaway pinch ratio is still a direction,
  // so ±Infinity clamps to the end of the range like any other overshoot.
  if (Number.isNaN(scale)) {
    return MIN_ZOOM;
  }
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** Pan limits: the image may travel until its edge reaches the stage edge, so
 *  a fitted (or smaller) axis is pinned at 0 and never drifts off-centre. */
export function panBounds(content: Size, stage: Size, scale: number): Point {
  return {
    x: Math.max(0, (content.width * scale - stage.width) / 2),
    y: Math.max(0, (content.height * scale - stage.height) / 2),
  };
}

export function clampOffset(offset: Point, content: Size, stage: Size, scale: number): Point {
  const bounds = panBounds(content, stage, scale);
  // `|| 0` keeps a pinned axis at +0 rather than -0, so the inline transform
  // never reads `-0px`.
  const clamp = (value: number, bound: number) => Math.min(bound, Math.max(-bound, value)) || 0;
  return { x: clamp(offset.x, bounds.x), y: clamp(offset.y, bounds.y) };
}

/** The offset that keeps `anchor` (stage-centre coordinates) over the same
 *  pixel of the image while the scale changes — the behaviour that makes
 *  wheel-zoom and double-click zoom feel anchored rather than jumpy. */
export function zoomAboutPoint(offset: Point, from: number, to: number, anchor: Point): Point {
  if (from <= 0) {
    return offset;
  }
  const ratio = to / from;
  return {
    x: anchor.x - (anchor.x - offset.x) * ratio,
    y: anchor.y - (anchor.y - offset.y) * ratio,
  };
}

/** Percentage shown in the toolbar. Fit is 100%, so this is relative to the
 *  fitted size rather than the image's natural pixels. */
export function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
