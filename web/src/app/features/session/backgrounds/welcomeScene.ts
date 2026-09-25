import type { AsciiAnimationFrame, AsciiAnimationScene } from "../../../components/ui/AsciiAnimation";
import { AsciiMeshRaster, rotationMatrix, type AsciiMaterial, type AsciiMesh } from "../../../components/ui/asciiMesh";

export type WelcomeIllustrationKind = "create" | "open";
type Vector = [number, number, number];
type Part = { mesh: AsciiMesh; direction: Vector };
const COLS = 100;
const ROWS = 44;
const TAU = Math.PI * 2;
const porcelain: AsciiMaterial = { albedo: 1.1, emission: 0 };
const metal: AsciiMaterial = { albedo: 0.48, emission: 0 };
const light: AsciiMaterial = { albedo: 1, emission: 0.9 };

/** Small original models for the welcome choices; independent of sign-in and Ship. */
class Model {
  private vertices: number[] = [];
  private indices: number[] = [];
  private materials: AsciiMaterial[] = [];

  face(points: Vector[], material: AsciiMaterial): void {
    const a = points[1].map((value, axis) => value - points[0][axis]);
    const b = points[2].map((value, axis) => value - points[0][axis]);
    const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const length = Math.hypot(...normal) || 1;
    const start = this.vertices.length / 6;
    for (const point of points) this.vertices.push(...point, ...normal.map((value) => value / length));
    for (let index = 1; index < points.length - 1; index++) {
      this.indices.push(start, start + index, start + index + 1);
      this.materials.push(material);
    }
  }

  build(): AsciiMesh {
    return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices), materials: this.materials };
  }
}

function world(): Part[] {
  const point = (latitude: number, longitude: number): Vector => [
    Math.cos(latitude) * Math.cos(longitude) * 1.16, Math.sin(latitude) * 1.16, Math.cos(latitude) * Math.sin(longitude) * 1.16,
  ];
  return Array.from({ length: 8 }, (_, segment) => {
    const model = new Model();
    for (let row = 0; row < 16; row++) for (let col = 0; col < 5; col++) {
      const longitude = (segment * 5 + col) / 40 * TAU;
      const latitude = -Math.PI / 2 + row / 16 * Math.PI;
      const land = Math.sin(longitude * 2 + Math.sin(latitude * 3))
        + Math.cos(latitude * 5 - longitude * 3) * 0.45;
      const material = land > 0.25 ? porcelain : { albedo: 0.42, emission: 0 };
      model.face([
        point(latitude, longitude), point(latitude + Math.PI / 16, longitude),
        point(latitude + Math.PI / 16, longitude + TAU / 40), point(latitude, longitude + TAU / 40),
      ], material);
    }
    const angle = (segment + 0.5) / 8 * TAU;
    return { mesh: model.build(), direction: [Math.cos(angle), 0, Math.sin(angle)] };
  });
}

function orbit(): AsciiMesh {
  const model = new Model();
  const point = (angle: number, radius: number): Vector => [Math.cos(angle) * radius, 0.3, Math.sin(angle) * radius];
  for (let index = 0; index < 72; index++) {
    if (index % 9 === 8) continue;
    const start = index / 72 * TAU, end = (index + 1) / 72 * TAU;
    model.face([point(start, 1.52), point(start, 1.56), point(end, 1.56), point(end, 1.52)], metal);
  }
  return model.build();
}

function gateway(): AsciiMesh {
  const model = new Model();
  // A deep, bevelled aperture with separated housings and an illuminated inner rim.
  const profile = [[1.13, -0.15], [1.13, 0.13], [1.2, 0.22], [1.39, 0.22], [1.47, 0.13], [1.47, -0.15]];
  for (let index = 0; index < 64; index++) {
    const gap = index % 8 === 0 ? 0.014 : 0;
    const start = index / 64 * TAU + gap, end = (index + 1) / 64 * TAU - gap;
    for (let side = 0; side < profile.length; side++) {
      const [r1, z1] = profile[side], [r2, z2] = profile[(side + 1) % profile.length];
      model.face([
        [Math.cos(start) * r1, Math.sin(start) * r1, z1], [Math.cos(start) * r2, Math.sin(start) * r2, z2],
        [Math.cos(end) * r2, Math.sin(end) * r2, z2], [Math.cos(end) * r1, Math.sin(end) * r1, z1],
      ], side === 1 ? light : side === 0 || side === 5 ? metal : porcelain);
    }
  }
  return model.build();
}

function iris(open: number): AsciiMesh {
  const model = new Model();
  const radius = 0.18 + open * 0.92;
  const point = (angle: number, size: number): Vector => [Math.cos(angle) * size, Math.sin(angle) * size, 0.04];
  for (let blade = 0; blade < 8; blade++) {
    const angle = blade / 8 * TAU;
    model.face([point(angle + 0.26, radius), point(angle, 1.17), point(angle + TAU / 8, 1.17), point(angle + TAU / 8 + 0.26, radius)],
      { albedo: blade % 2 === 0 ? 0.54 : 0.72, emission: 0 });
  }
  return model.build();
}

export function createWelcomeScene(kind: WelcomeIllustrationKind): AsciiAnimationScene {
  const raster = new AsciiMeshRaster(COLS, ROWS, { aspect: 1.62, perspective: 0.045 });
  const frames = new Map<number, AsciiAnimationFrame>();
  let parts: Part[] = [];
  let surround: AsciiMesh;
  let openIris: AsciiMesh;
  let cachedPalette: string | undefined;
  return {
    prepare() {
      parts = kind === "create" ? world() : [];
      surround = kind === "create" ? orbit() : gateway();
      if (kind === "open") openIris = iris(1);
    },
    stillAt: 4,
    frame(seconds, motion, palette = "dark") {
      if (cachedPalette !== palette) { frames.clear(); cachedPalette = palette; }
      const progress = Math.max(0, Math.min(1, (seconds - 0.3) / 2.5));
      const assembled = progress * progress * (3 - 2 * progress);
      const view = Math.round((Math.sin(motion ? seconds * 0.22 : 0) + 1) * 31.5);
      const cached = progress === 1 ? frames.get(view) : undefined;
      if (cached) return cached;
      const turn = view / 63 - 0.5;
      const matrix = kind === "create" ? rotationMatrix(-0.55 + turn * 0.45, -0.42, -0.12)
        : rotationMatrix(-0.38 + turn * 0.35, -0.18, 0.12);
      raster.clear();
      raster.mesh(surround, matrix, 23);
      if (kind === "create") {
        for (const { mesh, direction } of parts) {
          const distance = (1 - assembled) * 0.48;
          const offset = direction.map((value) => value * distance);
          const translation: Vector = [
            matrix[0] * offset[0] + matrix[2] * offset[2],
            matrix[3] * offset[0] + matrix[5] * offset[2],
            matrix[6] * offset[0] + matrix[8] * offset[2],
          ];
          raster.mesh(mesh, matrix, 23, 0, 1, translation);
        }
      } else {
        raster.mesh(progress === 1 ? openIris : iris(assembled), matrix, 23);
      }
      const frame = raster.frame(palette);
      if (progress === 1) frames.set(view, frame);
      return frame;
    },
  };
}
