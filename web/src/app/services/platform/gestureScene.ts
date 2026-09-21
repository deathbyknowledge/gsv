import type { AsciiAnimationFrame, AsciiAnimationScene } from "../../components/ui/AsciiAnimation";
import { AsciiMeshRaster, rotationMatrix } from "../../components/ui/asciiMesh";
import type { ColorTheme } from "../../components/ui/useColorTheme";
import { createHandModel, type HandModel } from "./handModel";

export type GestureLesson = 0 | 1 | 2 | 3 | 4 | 5 | "scroll";
export type GestureScene = AsciiAnimationScene & {
  beginTurn: () => void;
  turnBy: (radians: number) => void;
  endTurn: () => void;
  resetTurn: () => void;
};
export const GESTURE_FRAME_RATE = 18;
const COLS = 96;
const ROWS = 48;
const CYCLE_FRAMES = GESTURE_FRAME_RATE * 4;
const TAU = Math.PI * 2;
const TURN_SECONDS = 40;
const ANGLES = 720;
const CACHED_FRAMES = 128;
const PERSPECTIVE = 0.012;

// Bits are thumb, index, middle, ring, pinky. Alternate examples teach counts,
// without suggesting that a particular combination owns the command.
const examples: Record<Exclude<GestureLesson, "scroll">, readonly number[]> = {
  0: [0], 1: [2, 1], 2: [6, 3], 3: [14, 7], 4: [30, 15], 5: [31],
};
const raster = new AsciiMeshRaster(COLS, ROWS, { perspective: PERSPECTIVE });
let model: HandModel | undefined;
const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** A small palm and articulated digits, rasterized into the shared glyph host. */
function drawFrame(lesson: GestureLesson, mask: number, extension: number, tilt: number, yaw: number, palette: ColorTheme): AsciiAnimationFrame {
  const handModel = model ??= createHandModel();
  raster.clear();
  const paired = lesson === 0 || lesson === "scroll";
  const unit = paired ? 6.8 : 8.2;
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const pivotX = paired ? 0 : 0.45;
  const orbit = (x: number, y: number): [number, number, number] => [
    pivotX + (x - pivotX) * cosine, y, -(x - pivotX) * sine,
  ];
  const hand = (x: number, y: number, mirror: boolean, fingers: number, open: number) => {
    handModel.pose(fingers, open, mirror);
    const direction = mirror ? -1 : 1;
    const orientation = rotationMatrix((-0.30 + open * 0.12) * direction, -0.10, -0.035 * direction);
    const rotation = orientation.slice();
    // Apply the same parent yaw to the hand's orientation and its position.
    // The pair keeps one pivot between the palms, including their depth order.
    for (let column = 0; column < 3; column++) {
      rotation[column] = cosine * orientation[column] + sine * orientation[column + 6];
      rotation[column + 6] = cosine * orientation[column + 6] - sine * orientation[column];
    }
    raster.mesh(handModel.mesh, rotation, unit, 0, 1, orbit(x, y));
  };
  if (lesson === "scroll") {
    // Mirrored view: control palm on the left, action fist on the right.
    for (let step = 1; step < 16; step++) {
      const t = step / 16;
      const [x, y, z] = orbit(-4.3 + t * 8.6, 0.5 - tilt + t * tilt * 2);
      const perspective = 1 + z * PERSPECTIVE;
      raster.splat(raster.width / 2 + x * unit * 11 / 7 * perspective, raster.height / 2 + y * unit * perspective, z, 0.25, 0.65);
    }
    hand(-4.3, 0.5 - tilt, true, 31, 1);
    hand(4.3, 0.5 + tilt, false, 0, 0);
  } else if (lesson === 0) {
    hand(-4.3, 0.5, true, 31, extension);
    hand(4.3, 0.5, false, 31, extension);
  } else {
    hand(0.45, 0.5, false, mask, extension);
  }
  return raster.frame(palette);
}

export function createGestureScene(lesson: GestureLesson): GestureScene {
  // Cache only frames that have actually been displayed, with a finite loop.
  // Opening the guide never pre-renders all lessons on the UI thread.
  const frames = new Map<string, AsciiAnimationFrame>();
  const count = CYCLE_FRAMES * (lesson === "scroll" ? 1 : examples[lesson].length);
  let cachedPalette: ColorTheme | undefined;
  let angle = 0;
  let held = false;
  let poseSeconds: number | undefined;
  let lastSeconds: number | undefined;
  const listeners = new Set<() => void>();
  const invalidate = () => { for (const listener of listeners) listener(); };
  return {
    stillAt: 1.5,
    subscribe(redraw) { listeners.add(redraw); return () => { listeners.delete(redraw); }; },
    beginTurn() { held = true; invalidate(); },
    turnBy(radians) { angle = ((angle + radians) % TAU + TAU) % TAU; invalidate(); },
    endTurn() { held = false; invalidate(); },
    resetTurn() { angle = 0; invalidate(); },
    frame(seconds, motion, palette = "dark") {
      poseSeconds ??= seconds;
      const elapsed = motion && lastSeconds !== undefined ? Math.max(0, seconds - lastSeconds) : 0;
      lastSeconds = seconds;
      if (!held) {
        poseSeconds += elapsed;
        angle = (angle + elapsed * TAU / TURN_SECONDS) % TAU;
      }
      if (palette !== cachedPalette) { frames.clear(); cachedPalette = palette; }
      const frame = Math.floor(Math.max(0, poseSeconds) * GESTURE_FRAME_RATE) % count;
      const time = (frame % CYCLE_FRAMES) / GESTURE_FRAME_RATE;
      const mask = lesson === "scroll" ? 0 : examples[lesson][Math.floor(frame / CYCLE_FRAMES)];
      const extension = lesson === 0
        ? 1 - ease((time - 0.2) / 0.55) + ease((time - 2.7) / 0.55)
        : ease((time - 0.4) / 0.55) * (1 - ease((time - 2.8) / 0.55));
      const tilt = lesson === "scroll" && time >= 1 ? Math.sin((time - 1) * Math.PI * 2 / 3) * 0.95 : 0;
      // A held pose reuses the same frame throughout its hold interval.
      // Rotation adds views; retain only a bounded set for this mounted lesson.
      const view = Math.round(angle / TAU * ANGLES) % ANGLES;
      const key = `${view}:${lesson === "scroll" ? tilt : `${mask}:${extension}`}`;
      let result = frames.get(key);
      if (!result) {
        result = drawFrame(lesson, mask, extension, tilt, view / ANGLES * TAU, palette);
      }
      frames.delete(key);
      frames.set(key, result);
      if (frames.size > CACHED_FRAMES) frames.delete(frames.keys().next().value!);
      return result;
    },
  };
}
