import type { AsciiAnimationScene } from "./AsciiAnimation";
import { ASCII_ORBIT_PERIOD, createAsciiOrbit } from "./asciiOrbit";

export const SPINNER_FRAME_RATE = 18;
const FRAME_COUNT = 24;
export const SPINNER_PERIOD = FRAME_COUNT / SPINNER_FRAME_RATE;
export type SpinnerResolution = "inline" | "panel";
const scenes = new Map<SpinnerResolution, AsciiAnimationScene>();

/** Two small, shared glyph loops. A mounted loader only selects a cached string. */
export function spinnerScene(resolution: SpinnerResolution): AsciiAnimationScene {
  const existing = scenes.get(resolution);
  if (existing) return existing;
  const orbit = createAsciiOrbit(resolution === "inline" ? { cols: 32, rows: 20 } : { cols: 48, rows: 32 });
  const frames = Array.from({ length: FRAME_COUNT }, (_, index) => orbit.frame(index * ASCII_ORBIT_PERIOD / FRAME_COUNT, false));
  const scene: AsciiAnimationScene = {
    stillAt: SPINNER_PERIOD / 4,
    frame: (seconds) => frames[Math.floor(Math.max(0, seconds) * SPINNER_FRAME_RATE) % FRAME_COUNT],
  };
  scenes.set(resolution, scene);
  return scene;
}
