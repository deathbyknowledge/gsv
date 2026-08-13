import { describe, expect, it, vi } from "vitest";
import {
  FITTED_TEXT_HEIGHT_TARGET,
  FITTED_TEXT_MAX_SIZE,
  FITTED_TEXT_MIN_SIZE,
  FITTED_TEXT_SIZE_STEP,
  chooseFittedTextPolicy,
  fittedTextCandidates,
  fittedTextLineHeight,
  quantizeFittedTextSize,
  tightenFittedTextCeiling,
} from "./useFittedText";

describe("fitted text candidates", () => {
  it("uses the full bounded scale for a large viewport", () => {
    const candidates = fittedTextCandidates({ width: 1440, height: 900 });

    expect(candidates[0]).toBe(FITTED_TEXT_MAX_SIZE);
    expect(candidates.at(-1)).toBe(FITTED_TEXT_MIN_SIZE);
    expect(candidates.every((size) => size % FITTED_TEXT_SIZE_STEP === 0)).toBe(true);
    expect(candidates.every((size, index) => index === 0 || candidates[index - 1] - size === 2))
      .toBe(true);
  });

  it("derives a smaller preferred ceiling from compact viewports", () => {
    expect(fittedTextCandidates({ width: 390, height: 844 })[0]).toBe(34);
    expect(fittedTextCandidates({ width: 800, height: 600 })[0]).toBe(42);
    expect(fittedTextCandidates({ width: 240, height: 320 })).toEqual([24]);
  });

  it("clamps and quantizes caller-owned sizes", () => {
    expect(quantizeFittedTextSize(18)).toBe(24);
    expect(quantizeFittedTextSize(37)).toBe(38);
    expect(quantizeFittedTextSize(72)).toBe(54);
    expect(quantizeFittedTextSize(Number.NaN)).toBe(24);
  });

  it("lets a prepared stream shrink but never grow between viewport changes", () => {
    let ceiling: number | null = null;
    ceiling = tightenFittedTextCeiling(ceiling, 46);
    ceiling = tightenFittedTextCeiling(ceiling, 38);
    ceiling = tightenFittedTextCeiling(ceiling, 44);

    expect(ceiling).toBe(38);
  });
});

describe("fitted text policy", () => {
  it("chooses the largest size that fits the 78% height target", () => {
    const heights = new Map([
      [42, 430],
      [40, 405],
      [38, 388],
      [36, 360],
    ]);
    const policy = chooseFittedTextPolicy({
      candidates: [42, 40, 38, 36],
      availableHeight: 500,
      measureHeight: (fontSize) => heights.get(fontSize) ?? 0,
    });

    expect(policy).toEqual({
      fontSize: 38,
      lineHeight: fittedTextLineHeight(38),
      contentHeight: 388,
      targetHeight: 500 * FITTED_TEXT_HEIGHT_TARGET,
      scrolls: false,
    });
  });

  it("falls back to 24px and scrolls when no size meets the target", () => {
    const measureHeight = vi.fn(() => 500);
    const policy = chooseFittedTextPolicy({
      candidates: [30, 28, 26],
      availableHeight: 400,
      measureHeight,
    });

    expect(policy.fontSize).toBe(FITTED_TEXT_MIN_SIZE);
    expect(policy.scrolls).toBe(true);
    expect(measureHeight).toHaveBeenLastCalledWith(
      FITTED_TEXT_MIN_SIZE,
      fittedTextLineHeight(FITTED_TEXT_MIN_SIZE),
    );
  });

  it("measures only the quantized locked size and reports overflow", () => {
    const measureHeight = vi.fn(() => 700);
    const policy = chooseFittedTextPolicy({
      candidates: fittedTextCandidates({ width: 1440, height: 900 }),
      availableHeight: 600,
      lockedSize: 37,
      measureHeight,
    });

    expect(policy.fontSize).toBe(38);
    expect(policy.scrolls).toBe(true);
    expect(measureHeight).toHaveBeenCalledTimes(1);
    expect(measureHeight).toHaveBeenCalledWith(38, fittedTextLineHeight(38));
  });

  it("keeps a growing draft at or below its previous fitted size", () => {
    const measureHeight = vi.fn(() => 100);
    const policy = chooseFittedTextPolicy({
      candidates: [54, 52, 50, 48, 46, 44, 42, 40, 38, 36],
      availableHeight: 600,
      maximumSize: 39,
      measureHeight,
    });

    expect(policy.fontSize).toBe(38);
    expect(measureHeight).toHaveBeenCalledTimes(1);
    expect(measureHeight).toHaveBeenCalledWith(38, fittedTextLineHeight(38));
  });

  it("treats non-finite measurements as overflow", () => {
    const policy = chooseFittedTextPolicy({
      candidates: [24],
      availableHeight: 600,
      measureHeight: () => Number.NaN,
    });

    expect(policy.contentHeight).toBe(Number.POSITIVE_INFINITY);
    expect(policy.scrolls).toBe(true);
  });
});
