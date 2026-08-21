import { describe, expect, it } from "vitest";
import {
  clampOffset,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  panBounds,
  zoomAboutPoint,
  zoomPercent,
} from "./imageLightboxGeometry";

// The viewer centres the image in the stage and transforms it about that
// centre, so every coordinate below is relative to the stage centre.
const STAGE = { width: 800, height: 600 };
/** A fitted image: as wide as the stage, shorter than it. */
const CONTENT = { width: 800, height: 400 };

describe("clampZoom", () => {
  it("holds the scale inside the viewer's range", () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(40)).toBe(MAX_ZOOM);
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it("falls back to fit for a non-finite scale", () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_ZOOM);
  });
});

describe("panBounds", () => {
  it("allows no travel while the image fits", () => {
    expect(panBounds(CONTENT, STAGE, 1)).toEqual({ x: 0, y: 0 });
  });

  it("allows half the overflow on each axis once zoomed", () => {
    // At 2x the image is 1600x800 in an 800x600 stage: 800 of horizontal
    // overflow and 200 of vertical, half of each available in either direction.
    expect(panBounds(CONTENT, STAGE, 2)).toEqual({ x: 400, y: 100 });
  });
});

describe("clampOffset", () => {
  it("pins a fitted image to the centre", () => {
    expect(clampOffset({ x: 120, y: -80 }, CONTENT, STAGE, 1)).toEqual({ x: 0, y: 0 });
  });

  it("stops the image before its edge leaves the stage edge", () => {
    expect(clampOffset({ x: 900, y: -900 }, CONTENT, STAGE, 2)).toEqual({ x: 400, y: -100 });
  });

  it("leaves an in-bounds pan alone", () => {
    expect(clampOffset({ x: -50, y: 25 }, CONTENT, STAGE, 2)).toEqual({ x: -50, y: 25 });
  });
});

describe("zoomAboutPoint", () => {
  it("keeps the stage centre fixed when zooming from the centre", () => {
    expect(zoomAboutPoint({ x: 0, y: 0 }, 1, 2, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("keeps the pixel under the pointer in place", () => {
    // Doubling about a point 100px right of centre pushes the image 100px left,
    // so whatever sat under the pointer stays under it.
    expect(zoomAboutPoint({ x: 0, y: 0 }, 1, 2, { x: 100, y: 40 })).toEqual({ x: -100, y: -40 });
  });

  it("composes with an existing pan", () => {
    expect(zoomAboutPoint({ x: 60, y: 0 }, 2, 1, { x: 100, y: 0 })).toEqual({ x: 80, y: 0 });
  });

  it("ignores a degenerate starting scale", () => {
    expect(zoomAboutPoint({ x: 5, y: 5 }, 0, 2, { x: 10, y: 10 })).toEqual({ x: 5, y: 5 });
  });
});

describe("zoomPercent", () => {
  it("reads fit as 100%", () => {
    expect(zoomPercent(1)).toBe("100%");
    expect(zoomPercent(2.5)).toBe("250%");
    expect(zoomPercent(1.337)).toBe("134%");
  });
});
