import type { AsciiAnimationFrame, AsciiAnimationScene } from "../../../../components/ui/AsciiAnimation";
import { buildWayfarer, type ShipModel, type ShipPoint } from "./wayfarer";
import { rotationMatrix, ShipRaster } from "./shipRaster";

const COLS = 160;
const ROWS = 80;
const RAMP = " .,:;irsXA253hMHGS#9B&@";
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const smooth = (start: number, end: number, time: number) => {
  const amount = Math.max(0, Math.min(1, (time - start) / (end - start)));
  return amount * amount * (3 - 2 * amount);
};

export function createShipScene(arrival: boolean): AsciiAnimationScene {
  const raster = new ShipRaster(COLS, ROWS);
  const particles = new ShipRaster(COLS, ROWS);
  let model: ShipModel;
  return {
    prepare() { model = buildWayfarer(); },
    stillAt: 7,
    frame(seconds: number, motion: boolean): AsciiAnimationFrame {
      const time = arrival ? seconds : 7;
      const idle = smooth(4.5, 7, time);
      const clock = motion ? seconds : 0;
      const turn = smooth(1.8, 5.8, time);
      const yaw = mix(-1.02, -0.61, turn) + Math.sin(clock * 0.18) * 0.04 * idle;
      const pitch = mix(-0.12, -0.29, turn);
      const matrix = rotationMatrix(yaw, pitch, -0.085);
      const bob = Math.sin(clock * 0.4) * 0.025 * idle;
      const unit = raster.width / (6.4 * 1.62);
      const ignition = smooth(1.3, 4.1, time);
      const surface = smooth(1.9, 4.5, time);
      raster.clear();
      if (surface > 0) raster.mesh(model.mesh, matrix, unit, bob, ignition);
      const drawParticle = (point: ShipPoint, target: ShipRaster) => {
        const formed = smooth(0.3 + point.delay, 3.2 + point.delay, time);
        if (point.noise > 0.07 + formed * 0.93) return;
        const swirl = (1 - formed) * 0.9;
        const cosine = Math.cos(swirl), sine = Math.sin(swirl);
        const px = mix(point.sx * cosine - point.sy * sine, point.x, formed);
        const py = mix(point.sx * sine * 0.35 + point.sy * cosine, point.y, formed) + bob;
        const pz = mix(point.sz, point.z, formed);
        const x = matrix[0] * px + matrix[1] * py + matrix[2] * pz;
        const y = matrix[3] * px + matrix[4] * py + matrix[5] * pz;
        const z = matrix[6] * px + matrix[7] * py + matrix[8] * pz;
        const perspective = 1 + z * 0.045;
        const column = raster.width * 0.47 + x * unit * 1.62 * perspective;
        const row = raster.height * 0.49 + y * unit * perspective;
        const nx = matrix[0] * point.nx + matrix[1] * point.ny + matrix[2] * point.nz;
        const ny = matrix[3] * point.nx + matrix[4] * point.ny + matrix[5] * point.nz;
        const nz = matrix[6] * point.nx + matrix[7] * point.ny + matrix[8] * point.nz;
        const diffuse = Math.max(0, -0.37 * nx - 0.66 * ny + 0.66 * nz);
        const rim = Math.pow(1 - Math.min(1, Math.abs(nz)), 3);
        let light = Math.max((0.23 + diffuse * 0.63 + rim * 0.14) * point.albedo, point.emission * ignition);
        if (point.exhaust) light = point.emission * ignition * (0.9 + Math.sin(clock * 3 + point.phase) * 0.08);
        light = mix(0.1 + point.noise * 0.1, light, formed);
        if (point.exhaust && light < 0.08) return;
        target.splat(column, row, z, Math.min(1, light), point.exhaust ? 1.3 : 1.15);
      };
      if (surface < 1) {
        particles.clear();
        for (const point of model.points) {
          if (!point.exhaust) drawParticle(point, particles);
        }
        raster.crossfadeFrom(particles, surface);
      }
      for (const point of model.exhaust) drawParticle(point, raster);

      const cells = raster.resolve();
      const material: string[] = [], dust: string[] = [], highlights: string[] = [];
      for (let row = 0; row < ROWS; row++) {
        let foreground = "", nebula = "", stars = "";
        for (let column = 0; column < COLS; column++) {
          const value = cells[row * COLS + column];
          const glyph = RAMP[Math.min(RAMP.length - 1, Math.floor(value * RAMP.length))];
          nebula += value > 0.06 && value < 0.35 ? glyph : " ";
          foreground += value >= 0.35 && value < 0.8 ? glyph : " ";
          stars += value >= 0.8 ? glyph : " ";
        }
        material.push(foreground);
        dust.push(nebula);
        highlights.push(stars);
      }
      return { foreground: material.join("\n"), nebula: dust.join("\n"), stars: highlights.join("\n") };
    },
  };
}
