import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorRect } from "./Tooltip";
import { resolvePlacement } from "./Tooltip";

// resolvePlacement reads window.innerWidth/innerHeight. The repo runs tests in a
// node env with no DOM, so stub a fixed viewport and derive every expected value
// from the geometry in Tooltip.tsx by hand (GAP/MARGIN = 8, arrow inset = 10).
const VW = 800;
const VH = 600;

beforeEach(() => {
  vi.stubGlobal("window", { innerWidth: VW, innerHeight: VH });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A small anchor box, centered on (cx, cy) with the given size. */
function anchor(cx: number, cy: number, w = 40, h = 20): AnchorRect {
  return {
    left: cx - w / 2,
    right: cx + w / 2,
    top: cy - h / 2,
    bottom: cy + h / 2,
    width: w,
    height: h,
  };
}

const centered = anchor(400, 300); // left 380, right 420, top 290, bottom 310
const BW = 100;
const BH = 40;

describe("resolvePlacement — preferred side fits", () => {
  // Anchor is centered in the viewport with room on every side, so no side flips
  // and the bubble is centered on the cross axis. arrowOffset points at center.
  it("keeps top and centers the bubble over the anchor", () => {
    // top = anchor.top(290) - margin(8) - bh(40) = 242
    // left = anchorX(400) - bw/2(50) = 350; arrowOffset = 400 - 350 = 50
    expect(resolvePlacement(centered, BW, BH, "top")).toEqual({
      left: 350,
      top: 242,
      side: "top",
      arrowOffset: 50,
    });
  });

  it("keeps bottom", () => {
    // top = anchor.bottom(310) + margin(8) = 318
    expect(resolvePlacement(centered, BW, BH, "bottom")).toEqual({
      left: 350,
      top: 318,
      side: "bottom",
      arrowOffset: 50,
    });
  });

  it("keeps left and centers the bubble beside the anchor", () => {
    // left = anchor.left(380) - margin(8) - bw(100) = 272
    // top = anchorY(300) - bh/2(20) = 280; arrowOffset = 300 - 280 = 20
    expect(resolvePlacement(centered, BW, BH, "left")).toEqual({
      left: 272,
      top: 280,
      side: "left",
      arrowOffset: 20,
    });
  });

  it("keeps right", () => {
    // left = anchor.right(420) + margin(8) = 428
    expect(resolvePlacement(centered, BW, BH, "right")).toEqual({
      left: 428,
      top: 280,
      side: "right",
      arrowOffset: 20,
    });
  });
});

describe("resolvePlacement — flips to the opposite side", () => {
  it("flips top to bottom when top lacks room and bottom has more", () => {
    // anchor near the top: spaceTop = 20 < bh+margin(48), spaceBottom = 560 > 20
    const a = anchor(400, 30); // top 20, bottom 40
    // top = anchor.bottom(40) + margin(8) = 48
    expect(resolvePlacement(a, BW, BH, "top")).toEqual({
      left: 350,
      top: 48,
      side: "bottom",
      arrowOffset: 50,
    });
  });

  it("flips bottom to top when bottom lacks room and top has more", () => {
    // anchor near the bottom: spaceBottom = 20 < 48, spaceTop = 560 > 20
    const a = anchor(400, 570); // top 560, bottom 580
    // top = anchor.top(560) - margin(8) - bh(40) = 512
    expect(resolvePlacement(a, BW, BH, "bottom")).toEqual({
      left: 350,
      top: 512,
      side: "top",
      arrowOffset: 50,
    });
  });

  it("flips left to right when left lacks room and right has more", () => {
    // anchor near the left edge: spaceLeft = 20 < bw+margin(108), spaceRight = 740 > 20
    const a = anchor(40, 300); // left 20, right 60
    // left = anchor.right(60) + margin(8) = 68
    expect(resolvePlacement(a, BW, BH, "left")).toEqual({
      left: 68,
      top: 280,
      side: "right",
      arrowOffset: 20,
    });
  });

  it("flips right to left when right lacks room and left has more", () => {
    // anchor near the right edge: spaceRight = 20 < 108, spaceLeft = 740 > 20
    const a = anchor(760, 300); // left 740, right 780
    // left = anchor.left(740) - margin(8) - bw(100) = 632
    expect(resolvePlacement(a, BW, BH, "right")).toEqual({
      left: 632,
      top: 280,
      side: "left",
      arrowOffset: 20,
    });
  });
});

describe("resolvePlacement — does not flip when the opposite side is no better", () => {
  it("keeps top when the preferred side has equal room to its opposite (strict-inequality guard)", () => {
    // Centered anchor: spaceTop = spaceBottom = 290. A tall bubble means top does
    // not fit (290 < bh+margin = 308), but spaceBottom > spaceTop is false, so it
    // must NOT flip — this guards the strict `>` in the flip condition.
    const tallBh = 300;
    // top = anchor.top(290) - margin(8) - bh(300) = -18 (off-screen but valid math)
    expect(resolvePlacement(centered, BW, tallBh, "top")).toEqual({
      left: 350,
      top: -18,
      side: "top",
      arrowOffset: 50,
    });
  });

  it("keeps left when left has equal room to right (strict-inequality guard)", () => {
    // Centered anchor: spaceLeft = spaceRight = 380. A wide bubble means left does
    // not fit (380 < bw+margin), but spaceRight > spaceLeft is false → no flip.
    const wideBw = 400;
    // left = anchor.left(380) - margin(8) - bw(400) = -28
    expect(resolvePlacement(centered, wideBw, BH, "left")).toEqual({
      left: -28,
      top: 280,
      side: "left",
      arrowOffset: 20,
    });
  });
});

describe("resolvePlacement — cross-axis clamp into the viewport", () => {
  it("clamps to the left margin (top side) and re-aims the arrow at the anchor", () => {
    // anchor hugging the left edge: anchorX = 20, centered left = -30 → clamp to 8
    const a = anchor(20, 300, 20, 20); // left 10, right 30
    // arrowOffset = anchorX(20) - left(8) = 12 (still inside [10, 90])
    expect(resolvePlacement(a, BW, BH, "top")).toEqual({
      left: 8,
      top: 242,
      side: "top",
      arrowOffset: 12,
    });
  });

  it("clamps to the right margin (top side) and re-aims the arrow", () => {
    // anchor hugging the right edge: anchorX = 780, centered left = 730
    // hi = max(8, vw - margin - bw) = 692 → clamp to 692
    const a = anchor(780, 300, 20, 20); // left 770, right 790
    // arrowOffset = 780 - 692 = 88 (inside [10, 90])
    expect(resolvePlacement(a, BW, BH, "top")).toEqual({
      left: 692,
      top: 242,
      side: "top",
      arrowOffset: 88,
    });
  });

  it("clamps to the top margin (left side, vertical cross-axis)", () => {
    // anchor near the top with the left side: anchorY = 20, top = 0 → clamp to 8
    const a = anchor(400, 20); // top 10, bottom 30
    // arrowOffset = anchorY(20) - top(8) = 12 (inside [10, 30])
    expect(resolvePlacement(a, BW, BH, "left")).toEqual({
      left: 272,
      top: 8,
      side: "left",
      arrowOffset: 12,
    });
  });

  it("clamps to the bottom margin (left side, vertical cross-axis)", () => {
    // anchor near the bottom: anchorY = 580, top = 560
    // hi = max(8, vh - margin - bh) = 552 → clamp to 552
    const a = anchor(400, 580); // top 570, bottom 590
    // arrowOffset = 580 - 552 = 28 (inside [10, 30])
    expect(resolvePlacement(a, BW, BH, "left")).toEqual({
      left: 272,
      top: 552,
      side: "left",
      arrowOffset: 28,
    });
  });
});

describe("resolvePlacement — arrowOffset clamped to [10, size-10]", () => {
  it("clamps arrowOffset up to the 10px minimum inset in the corner", () => {
    // anchor jammed into the top-left corner: anchorX = 15, left clamps to 8,
    // raw arrowOffset = 15 - 8 = 7 → clamped up to 10
    const a = anchor(15, 300, 20, 20); // left 5, right 25
    expect(resolvePlacement(a, BW, BH, "top")).toEqual({
      left: 8,
      top: 242,
      side: "top",
      arrowOffset: 10,
    });
  });

  it("clamps arrowOffset down to bw-10 near the far edge", () => {
    // anchor near the right edge: anchorX = 785, left clamps to 692,
    // raw arrowOffset = 785 - 692 = 93 → clamped down to bw-10 = 90
    const a = anchor(785, 300, 20, 20); // left 775, right 795
    expect(resolvePlacement(a, BW, BH, "top")).toEqual({
      left: 692,
      top: 242,
      side: "top",
      arrowOffset: 90,
    });
  });
});

describe("resolvePlacement — all eight TooltipPosition mappings", () => {
  // A single centered anchor, exercising side + alignment for each position.
  it("maps center-aligned sides", () => {
    expect(resolvePlacement(centered, BW, BH, "top")).toMatchObject({ side: "top", left: 350, arrowOffset: 50 });
    expect(resolvePlacement(centered, BW, BH, "bottom")).toMatchObject({ side: "bottom", left: 350, arrowOffset: 50 });
    expect(resolvePlacement(centered, BW, BH, "left")).toMatchObject({ side: "left", top: 280, arrowOffset: 20 });
    expect(resolvePlacement(centered, BW, BH, "right")).toMatchObject({ side: "right", top: 280, arrowOffset: 20 });
  });

  it("pins -start to anchor.left", () => {
    // align start: anchorX = anchor.left = 380, left = anchor.left = 380
    // arrowOffset = 380 - 380 = 0 → clamped up to 10
    expect(resolvePlacement(centered, BW, BH, "top-start")).toEqual({
      left: 380,
      top: 242,
      side: "top",
      arrowOffset: 10,
    });
    expect(resolvePlacement(centered, BW, BH, "bottom-start")).toEqual({
      left: 380,
      top: 318,
      side: "bottom",
      arrowOffset: 10,
    });
  });

  it("pins -end to anchor.right - bw", () => {
    // align end: anchorX = anchor.right = 420, left = anchor.right - bw = 320
    // right edge = left + bw = 420 = anchor.right; arrowOffset = 420 - 320 = 100 → clamp to 90
    expect(resolvePlacement(centered, BW, BH, "top-end")).toEqual({
      left: 320,
      top: 242,
      side: "top",
      arrowOffset: 90,
    });
    expect(resolvePlacement(centered, BW, BH, "bottom-end")).toEqual({
      left: 320,
      top: 318,
      side: "bottom",
      arrowOffset: 90,
    });
  });
});

describe("resolvePlacement — degenerate bubbles larger than the viewport", () => {
  it("keeps lo <= hi with no NaN when the bubble is wider than the viewport", () => {
    // bw(900) > vw(800): hi = max(8, 800 - 8 - 900) = max(8, -108) = 8, so lo == hi == 8
    const wideBw = 900;
    const p = resolvePlacement(centered, wideBw, BH, "top");
    // left clamped to 8; arrowOffset = anchorX(400) - 8 = 392 (inside [10, 890])
    expect(p).toEqual({ left: 8, top: 242, side: "top", arrowOffset: 392 });
    expect(Number.isNaN(p.left)).toBe(false);
    expect(Number.isNaN(p.arrowOffset)).toBe(false);
  });

  it("keeps lo <= hi with no NaN when the bubble is taller than the viewport", () => {
    // bh(700) > vh(600): hi = max(8, 600 - 8 - 700) = 8, so lo == hi == 8
    const tallBh = 700;
    const p = resolvePlacement(centered, BW, tallBh, "left");
    // top clamped to 8; arrowOffset = anchorY(300) - 8 = 292 (inside [10, 690])
    expect(p).toEqual({ left: 272, top: 8, side: "left", arrowOffset: 292 });
    expect(Number.isNaN(p.top)).toBe(false);
    expect(Number.isNaN(p.arrowOffset)).toBe(false);
  });
});
