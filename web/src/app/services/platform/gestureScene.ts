import type { AsciiAnimationFrame, AsciiAnimationScene } from "../../components/ui/AsciiAnimation";

export type GestureLesson = 0 | 1 | 2 | 3 | 4 | 5 | "scroll";
export const GESTURE_FRAME_RATE = 12;
const COLS = 72;
const ROWS = 36;
const CYCLE_FRAMES = 48;
const RAMP = " .:;+*#@";
type Point = readonly [number, number];
type Capsule = { from: Point; to: Point; radius: number };

// Bits are thumb, index, middle, ring, pinky. Alternate examples teach counts,
// without suggesting that a particular combination owns the command.
const examples: Record<Exclude<GestureLesson, "scroll">, readonly number[]> = {
  0: [0], 1: [2, 1], 2: [6, 3], 3: [14, 7], 4: [30, 15], 5: [31],
};
const scenes = new Map<GestureLesson, AsciiAnimationScene>();

const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
const mix = (from: Point, to: Point, amount: number): Point => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
];

/** A small palm and articulated digits, rasterized into the shared glyph host. */
function drawFrame(lesson: GestureLesson, frame: number): AsciiAnimationFrame {
  const cells = new Float32Array(COLS * ROWS);
  const seconds = (frame % CYCLE_FRAMES) / GESTURE_FRAME_RATE;
  const hand = (center: Point, scale: number, mirror: boolean, mask: number, extension: number) => {
    const project = ([x, y]: Point): Point => [center[0] + (mirror ? -x : x) * scale, center[1] + y * scale];
    const capsule = ({ from, to, radius }: Capsule, shade = 0.8) => {
      const a = project(from);
      const b = project(to);
      const r = radius * scale;
      const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - r) / 0.6 + COLS / 2));
      const x1 = Math.min(COLS - 1, Math.ceil((Math.max(a[0], b[0]) + r) / 0.6 + COLS / 2));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r + ROWS / 2));
      const y1 = Math.min(ROWS - 1, Math.ceil(Math.max(a[1], b[1]) + r + ROWS / 2));
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      for (let row = y0; row <= y1; row++) {
        for (let column = x0; column <= x1; column++) {
          const x = (column - COLS / 2) * 0.6;
          const y = row - ROWS / 2;
          const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared));
          const distance = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
          if (distance > r + 0.3) continue;
          const coverage = Math.max(0, Math.min(1, (r + 0.3 - distance) / 0.6));
          cells[row * COLS + column] = coverage * (0.3 + shade * 0.6 * Math.sqrt(Math.max(0, 1 - (distance / (r + 0.3)) ** 2)));
        }
      }
    };
    capsule({ from: [-0.3, -0.7], to: [0, 3.2], radius: 4.1 }, 0.56);
    capsule({ from: [0, 4], to: [0, 8], radius: 2.5 }, 0.6);
    const bases: readonly Point[] = [[-3.1, -2.8], [-1, -3.5], [1.2, -3.1], [3.1, -2.1]];
    const lengths = [7.1, 8.4, 7.5, 5.7];
    for (let finger = 0; finger < 4; finger++) {
      const open = mask & (1 << (finger + 1)) ? extension : 0;
      let point = bases[finger];
      for (let joint = 0; joint < 3; joint++) {
        const bend = (1 - open) * [1.1, 2.3, 3.0][joint];
        const length = lengths[finger] * [0.43, 0.32, 0.25][joint];
        const next: Point = [point[0] + (finger - 1.5) * 0.10 * open, point[1] - Math.cos(bend) * length];
        capsule({ from: point, to: next, radius: 0.83 - joint * 0.05 }, 0.95 - joint * (1 - open) * 0.15);
        point = next;
      }
    }
    const thumb = mask & 1 ? extension : 0;
    const folded: readonly Point[] = [[-3.7, 2.2], [-3.8, -0.2], [-1.8, -0.6], [0.5, 0.2]];
    const stretched: readonly Point[] = [[-3.7, 2.2], [-5.8, 0.2], [-7.4, -1.4], [-8.5, -3.1]];
    for (let joint = 0; joint < 3; joint++) {
      capsule({ from: mix(folded[joint], stretched[joint], thumb), to: mix(folded[joint + 1], stretched[joint + 1], thumb), radius: 0.95 - joint * 0.08 });
    }
  };

  if (lesson === "scroll") {
    const tilt = seconds < 1 ? 0 : Math.sin((seconds - 1) * Math.PI * 2 / 3) * 3;
    // Mirrored view: control palm on the left, action fist on the right.
    hand([-10, 1 - tilt], 0.85, true, 31, 1);
    hand([10, 1 + tilt], 0.85, false, 0, 0);
    const left: Point = [-10, 1 - tilt];
    const right: Point = [10, 1 + tilt];
    for (let step = 1; step < 10; step++) {
      const point = mix(left, right, step / 10);
      const column = Math.round(point[0] / 0.6 + COLS / 2);
      const row = Math.round(point[1] + ROWS / 2);
      const index = row * COLS + column;
      if (!cells[index]) cells[index] = 0.22;
    }
  } else if (lesson === 0) {
    const extension = 1 - ease((seconds - 0.2) / 0.45) + ease((seconds - 2.7) / 0.45);
    hand([-10, 1], 0.85, true, 31, extension);
    hand([10, 1], 0.85, false, 31, extension);
  } else {
    const variants = examples[lesson];
    const mask = variants[Math.floor(frame / CYCLE_FRAMES) % variants.length];
    const extension = ease((seconds - 0.4) / 0.45) * (1 - ease((seconds - 2.8) / 0.45));
    hand([1.5, 2], 1.1, false, mask, extension);
  }
  const lines: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    let line = "";
    for (let column = 0; column < COLS; column++) {
      const value = cells[row * COLS + column];
      line += value === 0 ? " " : RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.floor(value * RAMP.length)))];
    }
    lines.push(line);
  }
  return { foreground: lines.join("\n") };
}

export function gestureScene(lesson: GestureLesson): AsciiAnimationScene {
  const existing = scenes.get(lesson);
  if (existing) return existing;
  // Cache only frames that have actually been displayed, with a finite loop.
  // Opening the guide never pre-renders all lessons on the UI thread.
  const frames = new Map<number, AsciiAnimationFrame>();
  const count = CYCLE_FRAMES * (lesson === "scroll" ? 1 : examples[lesson].length);
  const scene: AsciiAnimationScene = {
    stillAt: 1.5,
    frame(seconds) {
      const frame = Math.floor(Math.max(0, seconds) * GESTURE_FRAME_RATE) % count;
      let result = frames.get(frame);
      if (!result) { result = drawFrame(lesson, frame); frames.set(frame, result); }
      return result;
    },
  };
  scenes.set(lesson, scene);
  return scene;
}
