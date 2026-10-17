import type { AsciiAnimationScene } from "../../../components/ui/AsciiAnimation";
import { AsciiMeshRaster } from "../../../components/ui/asciiMesh";

/** Steve's "Spiral" study (ascii-animation-studies, September 2026): a familiar center of gravity. */
type SpiralPoint = { x: number; y: number; z: number; sx: number; sy: number; sz: number; brightness: number; delay: number };

const TAU = Math.PI * 2;
const SEED = 42;
const TILT = 1.06;
const ROLL = -0.35;
const SPEED = 0.085;
const FORMED_AT = 3.2;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

export function buildSpiral(): SpiralPoint[] {
  const rand = random(SEED);
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 0.00001))) * Math.cos(TAU * rand());
  const points: SpiralPoint[] = [];
  const add = (x: number, y: number, z: number, brightness: number) => {
    const angle = rand() * TAU;
    const distance = 1.2 + rand() * 1.6;
    points.push({ x, y, z, brightness, sx: Math.cos(angle) * distance, sy: Math.sin(angle) * distance, sz: normal() * 0.8, delay: rand() * 0.65 });
  };
  for (let i = 0; i < 8600; i += 1) {
    const r = Math.pow(rand(), 0.78) * 1.28;
    const a = (i % 2) * Math.PI + r * 5.3 + normal() * (0.12 + 0.22 * (1 - r / 1.28));
    add(r * Math.cos(a), r * Math.sin(a), normal() * 0.045, 0.28 + 0.5 * Math.pow(1 - r / 1.3, 1.3) + rand() * 0.16);
  }
  for (let i = 0; i < 900; i += 1) add(normal() * 0.13, normal() * 0.13, normal() * 0.055, 0.75 + rand() * 0.25);
  return points;
}

/** The galaxy assembles from scattered dust, then keeps turning slowly. */
export function createSpiralScene(cols = 144, rows = 72): AsciiAnimationScene {
  const raster = new AsciiMeshRaster(cols, rows, { aspect: 1.62, perspective: 0.1 });
  let points: SpiralPoint[] = [];
  return {
    prepare() { points = buildSpiral(); },
    stillAt: FORMED_AT,
    frame(seconds, motion, palette = "dark") {
      const time = motion ? seconds : FORMED_AT;
      const turn = time * SPEED;
      const ca = Math.cos(turn), sa = Math.sin(turn);
      const ct = Math.cos(TILT), st = Math.sin(TILT);
      const cr = Math.cos(ROLL), sr = Math.sin(ROLL);
      const unit = raster.height * 0.335;
      const exposure = palette === "dark" ? 1.25 : 1;
      raster.clear();
      for (const point of points) {
        const k = Math.max(0, Math.min(1, (time - point.delay) / 2.4));
        const formed = 1 - (1 - k) ** 3;
        let x = point.sx + (point.x - point.sx) * formed;
        let y = point.sy + (point.y - point.sy) * formed;
        let z = point.sz + (point.z - point.sz) * formed;
        // Spin about the galaxy's own axis, then tilt and roll the view, as in the study.
        [x, y] = [x * ca - y * sa, x * sa + y * ca];
        [y, z] = [y * ct - z * st, y * st + z * ct];
        [x, y] = [x * cr - y * sr, x * sr + y * cr];
        const perspective = 1 + z * 0.1;
        const light = Math.min(1, point.brightness * (0.8 + (z + 1) * 0.19) * (0.3 + 0.7 * formed) * exposure);
        raster.splat(raster.width / 2 + x * unit * 1.62 * perspective, raster.height / 2 + y * unit * perspective, z, light);
      }
      return raster.frame(palette);
    },
  };
}
