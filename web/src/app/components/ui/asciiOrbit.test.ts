import { describe, expect, it } from "vitest";
import { createAsciiOrbit } from "./asciiOrbit";

describe("ASCII orbit scene", () => {
  it("fits the requested glyph grid at every sampled rotation", () => {
    const scene = createAsciiOrbit({ cols: 80, rows: 32 });
    for (const seconds of [0, 4, 12, 1000]) {
      const lines = scene.frame(seconds, true).foreground.split("\n");
      expect(lines).toHaveLength(32);
      expect(lines.every((line) => line.length === 80)).toBe(true);
      expect(lines.join("")).toMatch(/^[ ·:+*#@]+$/u);
      expect(lines.join("").trim().length).toBeGreaterThan(0);
    }
  });
  it("is deterministic at its still frame and moves when the clock advances", () => {
    const first = createAsciiOrbit();
    const second = createAsciiOrbit();
    expect(first.frame(first.stillAt, false)).toEqual(second.frame(second.stillAt, false));
    expect(first.frame(0, true).foreground).not.toBe(first.frame(1, true).foreground);
  });
});
