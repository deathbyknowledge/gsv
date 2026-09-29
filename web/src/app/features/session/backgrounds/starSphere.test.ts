import { describe, expect, it } from "vitest";
import { createStarSphere, projectStarSphere, STAR_HEIGHT, STAR_WIDTH, visibleStars } from "./starSphere";
import type { SkyStar } from "./starSphere";

const sphere = createStarSphere(0.013);
const projected = projectStarSphere(sphere);

describe("fixed star sky", () => {
  it("creates a repeatable whole sphere, independent of the viewport", () => {
    expect(createStarSphere(0.013)).toEqual(sphere);
    expect(sphere.some((star) => star.z < -0.9)).toBe(true);
    expect(sphere.some((star) => star.z > 0.9)).toBe(true);
    for (const star of sphere) {
      expect(star.x ** 2 + star.y ** 2 + star.z ** 2).toBeCloseTo(1, 12);
    }
    expect(createStarSphere(0)).toEqual([]);
  });

  it("excludes the rear hemisphere and projects each glyph cell only once", () => {
    const star: SkyStar = { id: 0, x: 0, y: 0, z: 1, phase: 1, rate: 1, base: 0.4, bright: false };
    expect(projectStarSphere([
      star,
      { ...star, id: 1 },
      { ...star, id: 2, z: -1 },
      { ...star, id: 3, x: 1, z: 0 },
    ])).toEqual([{ star, x: 0, y: 0 }]);
    expect(new Set(projected.map(({ x, y }) => `${x},${y}`)).size).toBe(projected.length);
    for (const point of projected) {
      expect(point.star.z).toBeGreaterThan(0);
      expect(point.x / STAR_WIDTH).toBe(Math.round(point.x / STAR_WIDTH));
      expect(point.y / STAR_HEIGHT).toBe(Math.round(point.y / STAR_HEIGHT));
    }
  });

  it("retains the same stars and positions through one-pixel resizing and returning to the original size", () => {
    const original = visibleStars(projected, 1920, 1080);
    for (let delta = 1; delta <= 60; delta += 1) {
      const larger = new Set(visibleStars(projected, 1920 + delta, 1080 + delta));
      for (const star of original) expect(larger.has(star)).toBe(true);
    }
    expect(visibleStars(projected, 1920, 1080)).toEqual(original);
  });

  it("crops the same central sky across portrait, landscape, and large windows", () => {
    const centre = visibleStars(projected, 320, 240);
    for (const [width, height] of [[390, 844], [2560, 1440], [3440, 1440], [7680, 4320]]) {
      const visible = visibleStars(projected, width, height);
      const expected = projected.filter(({ x, y }) => {
        const screenX = x + Math.floor(width / 2);
        const screenY = y + Math.floor(height / 2);
        return screenX + STAR_WIDTH > 0 && screenX < width && screenY + STAR_HEIGHT > 0 && screenY < height;
      });
      expect(visible).toEqual(expected);
      for (const star of centre) expect(visible.includes(star)).toBe(true);
    }
    expect(visibleStars(projected, 0, 1080)).toEqual([]);
    expect(visibleStars(projected, 1920, 0)).toEqual([]);
  });
});
