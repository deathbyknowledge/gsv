import type { AsciiAnimationScene } from "../../../../components/ui/AsciiAnimation";
import { AsciiMeshRaster, rotationMatrix } from "../../../../components/ui/asciiMesh";
import { buildVoyager, type VoyagerPoint } from "./voyager";

export function createShipScene() {
  const raster = new AsciiMeshRaster(120, 60, { aspect: 1.62, perspective: 0.1 });
  let particles: AsciiMeshRaster | undefined;
  let model: ReturnType<typeof buildVoyager>;
  let heading = 0, pitch = 0;
  const listeners = new Set<() => void>();
  const scene: AsciiAnimationScene & { turn(dx: number, dy: number): void; reset(): void } = {
    prepare() { model = buildVoyager(); },
    stillAt: 4,
    subscribe(redraw) { listeners.add(redraw); return () => { listeners.delete(redraw); }; },
    turn(dx, dy) {
      heading = (heading + dx) % (Math.PI * 2);
      pitch = Math.max(-1.35, Math.min(1.35, pitch + dy));
      for (const listener of listeners) listener();
    },
    reset() { heading = 0; pitch = 0; for (const listener of listeners) listener(); },
    frame(seconds, motion, palette = "dark") {
      const time = motion ? seconds : 4;
      const idle = motion ? Math.max(0, seconds - 3.2) : 0;
      const angle = heading + Math.sin(idle * 0.16) * 0.22;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      const view = rotationMatrix(0, 0.82 + pitch, 0.65);
      // Voyager's wings lie in XY. Turn around their normal before tilting the view.
      const matrix = [
        view[0] * cosine + view[1] * sine, view[1] * cosine - view[0] * sine, view[2],
        view[3] * cosine + view[4] * sine, view[4] * cosine - view[3] * sine, view[5],
        view[6] * cosine + view[7] * sine, view[7] * cosine - view[6] * sine, view[8],
      ];
      const unit = raster.height * 0.335;
      const exposure = palette === "dark" ? 1.65 : 1;
      const transition = Math.max(0, Math.min(1, (time - 1.8) / 1.4));
      const surface = transition * transition * (3 - 2 * transition);
      raster.clear();
      if (surface > 0) raster.mesh(model.mesh, matrix, unit);
      const drawPoint = (point: VoyagerPoint, target: AsciiMeshRaster) => {
        if (time <= point.delay) return;
        const t = Math.max(0, Math.min(1, (time - point.delay) / 2.4));
        const formed = 1 - (1 - t) ** 3;
        const px = point.sx + (point.x - point.sx) * formed;
        const py = point.sy + (point.y - point.sy) * formed;
        const pz = point.sz + (point.z - point.sz) * formed;
        const x = matrix[0] * px + matrix[1] * py + matrix[2] * pz;
        const y = matrix[3] * px + matrix[4] * py + matrix[5] * pz;
        const z = matrix[6] * px + matrix[7] * py + matrix[8] * pz;
        const perspective = 1 + z * 0.1;
        const flicker = point.flicker === undefined ? 1 : 0.91 + Math.sin(idle * 3 + point.flicker) * 0.09;
        const light = Math.min(1, point.brightness * (0.8 + (z + 1) * 0.19) * (0.3 + 0.7 * formed) * flicker * exposure);
        target.splat(raster.width / 2 + x * unit * 1.62 * perspective, raster.height / 2 + y * unit * perspective, z, light, 1.15);
      };
      if (surface < 1) {
        particles ??= new AsciiMeshRaster(120, 60);
        particles.clear();
        for (const point of model.points) drawPoint(point, particles);
        raster.crossfadeFrom(particles, surface);
      } else {
        particles = undefined;
      }
      for (const point of model.details) drawPoint(point, raster);
      return raster.frame(palette);
    },
  };
  return scene;
}
