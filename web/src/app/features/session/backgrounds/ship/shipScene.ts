import type { AsciiAnimationFrame, AsciiAnimationScene } from "../../../../components/ui/AsciiAnimation";
import type { ColorTheme } from "../../../../components/ui/useColorTheme";
import { buildOpenCountry, sampleShipSurface, type ShipModel, type ShipPoint } from "./openCountry";
import { rotationMatrix, AsciiMeshRaster } from "../../../../components/ui/asciiMesh";

const COLS = 160;
const ROWS = 80;
const PROJECTION = { centerX: 0.43, centerY: 0.51, aspect: 1.62, perspective: 0.035 };
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const smooth = (start: number, end: number, time: number) => {
  const amount = Math.max(0, Math.min(1, (time - start) / (end - start)));
  return amount * amount * (3 - 2 * amount);
};

export function createShipScene(arrival: boolean): AsciiAnimationScene {
  const raster = new AsciiMeshRaster(COLS, ROWS, PROJECTION);
  let particles: AsciiMeshRaster | undefined;
  let points: ShipPoint[] | undefined;
  let model: ShipModel;
  return {
    prepare() { model = buildOpenCountry(!arrival); },
    stillAt: 7,
    frame(seconds: number, motion: boolean, palette: ColorTheme = "dark"): AsciiAnimationFrame {
      const time = arrival ? seconds : 7;
      const idle = smooth(4.5, 7, time);
      const clock = motion ? seconds : 0;
      const surface = smooth(1.9, 4.5, time);
      if (surface === 1) {
        particles = undefined;
        points = undefined;
      }
      const turn = smooth(1.8, 5.8, time);
      const yaw = mix(-0.93, -0.65, turn) + Math.sin(clock * 0.18) * 0.025 * idle;
      const pitch = mix(-0.23, -0.37, turn);
      const matrix = rotationMatrix(yaw, pitch, -0.035);
      const bob = Math.sin(clock * 0.4) * 0.025 * idle;
      const unit = raster.width / (6.65 * 1.62);
      const ignition = smooth(1.3, 4.1, time);
      raster.clear();
      if (surface > 0) raster.mesh(model.mesh, matrix, unit, bob, ignition);
      const drawParticle = (point: ShipPoint, target: AsciiMeshRaster) => {
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
        const perspective = 1 + z * 0.035;
        const column = raster.width * 0.43 + x * unit * 1.62 * perspective;
        const row = raster.height * 0.51 + y * unit * perspective;
        const nx = matrix[0] * point.nx + matrix[1] * point.ny + matrix[2] * point.nz;
        const ny = matrix[3] * point.nx + matrix[4] * point.ny + matrix[5] * point.nz;
        const nz = matrix[6] * point.nx + matrix[7] * point.ny + matrix[8] * point.nz;
        const diffuse = Math.max(0, -0.42 * nx - 0.69 * ny + 0.58 * nz);
        const rim = Math.pow(1 - Math.min(1, Math.abs(nz)), 3);
        let light = Math.max((0.25 + diffuse * 0.65 + rim * 0.1) * point.albedo, point.emission * ignition);
        light = mix(0.1 + point.noise * 0.1, light, formed);
        target.splat(column, row, z, Math.min(1, light), 1.15);
      };
      if (surface < 1) {
        particles ??= new AsciiMeshRaster(COLS, ROWS, PROJECTION);
        points ??= sampleShipSurface(model.mesh);
        particles.clear();
        for (const point of points) drawParticle(point, particles);
        raster.crossfadeFrom(particles, surface);
      }
      raster.glow(model.driveGlow, matrix, unit, bob, ignition);

      return raster.frame(palette);
    },
  };
}
