import type { AsciiAnimationFrame, AsciiAnimationScene } from "../app/components/ui/AsciiAnimation";
import { AsciiMeshRaster, rotationMatrix, type AsciiMaterial, type AsciiMesh } from "../app/components/ui/asciiMesh";

type Vector = [number, number, number];
export const COMPUTER_COLUMNS = 80;
export const COMPUTER_ROWS = 36;
const shell: AsciiMaterial = { albedo: 0.94, emission: 0 };
const recess: AsciiMaterial = { albedo: 0.13, emission: 0 };
const keycap: AsciiMaterial = { albedo: 0.66, emission: 0 };
const phosphor: AsciiMaterial = { albedo: 1, emission: 0.86 };

function computerModel(): AsciiMesh {
  const vertices: number[] = [], indices: number[] = [], materials: AsciiMaterial[] = [];
  const box = (center: Vector, size: Vector, material: AsciiMaterial) => {
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      for (const side of [-1, 1]) {
        const normal: Vector = [0, 0, 0];
        normal[axis] = side;
        const start = vertices.length / 6;
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const point: Vector = [...center];
          point[axis] += size[axis] * side / 2;
          point[u] += size[u] * a / 2;
          point[v] += size[v] * b / 2;
          vertices.push(...point, ...normal);
        }
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
        materials.push(material, material);
      }
    }
  };

  // A compact terminal: deep monitor casing, inset glass, a stand, and real keys.
  box([0, -0.37, -0.1], [2.55, 1.9, 1.03], shell);
  box([0, -0.46, 0.425], [2.19, 1.47, 0.025], recess);
  box([0, -0.48, 0.445], [1.98, 1.25, 0.02], { albedo: 0.23, emission: 0 });
  box([0, 0.67, -0.14], [0.44, 0.3, 0.45], keycap);
  box([0, 0.86, -0.08], [1.44, 0.13, 0.92], shell);
  box([0.94, 0.42, 0.435], [0.11, 0.07, 0.02], phosphor);
  for (let line = 0; line < 3; line++) {
    const width = [0.8, 1.15, 0.49][line];
    box([-0.77 + width / 2, -0.83 + line * 0.23, 0.463], [width, 0.035, 0.012], keycap);
  }
  box([-0.73, -0.06, 0.464], [0.16, 0.055, 0.012], phosphor);
  box([0, 1.01, 1.18], [2.54, 0.15, 0.87], shell);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 10; col++) {
    box([-1.07 + col * 0.237, 0.907, 0.91 + row * 0.18], [0.18, 0.065, 0.13], keycap);
  }
  box([0, 0.906, 1.46], [1.14, 0.07, 0.13], keycap);
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), materials };
}

export function createComputerScene(): AsciiAnimationScene {
  const raster = new AsciiMeshRaster(COMPUTER_COLUMNS, COMPUTER_ROWS, { centerY: 0.46, perspective: 0.02 });
  const frames = new Map<number, AsciiAnimationFrame>();
  let model: AsciiMesh;
  let cachedPalette: string | undefined;
  return {
    prepare() { model = computerModel(); },
    stillAt: 0,
    frame(seconds, motion, palette = "dark") {
      if (palette !== cachedPalette) { frames.clear(); cachedPalette = palette; }
      const view = Math.round((Math.sin(motion ? seconds * 0.24 : 0) + 1) * 31.5);
      let frame = frames.get(view);
      if (!frame) {
        raster.clear();
        raster.mesh(model, rotationMatrix(-0.4 + (view / 63 - 0.5) * 0.44, -0.3, 0), 21);
        frame = raster.frame(palette);
        frames.set(view, frame);
      }
      return frame;
    },
  };
}
