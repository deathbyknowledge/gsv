import { describe, expect, it } from "vitest";
import { spinnerScene, SPINNER_FRAME_RATE, SPINNER_PERIOD } from "./spinnerScene";

describe("shared sphere loader loop", () => {
  it("reuses one cached scene and its frames for each size class", () => {
    const inline = spinnerScene("inline");
    const panel = spinnerScene("panel");
    expect(spinnerScene("inline")).toBe(inline);
    expect(spinnerScene("panel")).toBe(panel);
    expect(panel).not.toBe(inline);
    expect(inline.frame(0, true)).toBe(inline.frame(SPINNER_PERIOD, true));
    expect(inline.frame(0, true)).toBe(inline.frame(0, false));
  });

  it("keeps tiny loaders on a bounded grid with visibly changing frames", () => {
    for (const resolution of ["inline", "panel"] as const) {
      const scene = spinnerScene(resolution);
      const frames = new Set<string>();
      for (let index = 0; index < 24; index += 1) {
        const frame = scene.frame(index / SPINNER_FRAME_RATE, true).foreground;
        const lines = frame.split("\n");
        expect(lines).toHaveLength(resolution === "inline" ? 20 : 32);
        expect(lines.every((line) => line.length === (resolution === "inline" ? 32 : 48))).toBe(true);
        expect(frame.trim()).not.toBe("");
        frames.add(frame);
      }
      expect(frames.size).toBeGreaterThan(12);
    }
  });
});
