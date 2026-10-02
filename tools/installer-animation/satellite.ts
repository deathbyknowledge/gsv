import { AsciiMeshRaster, rotationMatrix, type AsciiMaterial, type AsciiMesh } from "../../web/src/app/components/ui/asciiMesh";
import type { AsciiAnimationFrame } from "../../web/src/app/components/ui/AsciiAnimation";

type Point = [number, number, number];
const TAU = Math.PI * 2;
const smooth = (time: number) => { const t = Math.max(0, Math.min(1, time)); return t * t * (3 - 2 * t); };
function rotate(point: Point, matrix: number[]): Point {
  return [matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2],
    matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2],
    matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2]];
}

// Geometry is rendered only while generating the cached terminal frames.
class Mesh {
  vertices: number[] = [];
  indices: number[] = [];
  materials: AsciiMaterial[] = [];

  triangle(a: Point, b: Point, c: Point, albedo: number, emission = 0): void {
    const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n);
    if (length < 0.00001) return;
    const normal = n.map(value => value / length);
    const index = this.vertices.length / 6;
    for (const p of [a, b, c]) this.vertices.push(...p, ...normal);
    this.indices.push(index, index + 1, index + 2);
    this.materials.push({ albedo, emission });
  }

  quad(a: Point, b: Point, c: Point, d: Point, albedo: number, emission = 0): void {
    this.triangle(a, b, c, albedo, emission); this.triangle(a, c, d, albedo, emission);
  }

  box(center: Point, size: Point, albedo: number, emission = 0, transform: (point: Point) => Point = point => point): void {
    const [x, y, z] = center, [w, h, d] = size.map(value => value / 2);
    const p = (a: number, b: number, c: number) => transform([x + a * w, y + b * h, z + c * d]);
    this.quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), albedo, emission);
    this.quad(p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1), albedo, emission);
    this.quad(p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1), albedo, emission);
    this.quad(p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), albedo, emission);
    this.quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), albedo, emission);
    this.quad(p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1), albedo, emission);
  }

  rod(a: Point, b: Point, radius = 0.018, albedo = 1): void {
    const axis = b.map((v, i) => v - a[i]);
    const length = Math.hypot(...axis);
    const n = axis.map(v => v / length);
    const u: Point = Math.abs(n[1]) < 0.9 ? [-n[2], 0, n[0]] : [0, -n[2], n[1]];
    const scale = radius / Math.hypot(...u);
    for (let i = 0; i < 3; i++) u[i] *= scale;
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const ring = (p: Point, angle: number): Point => [p[0] + u[0] * Math.cos(angle) + v[0] * Math.sin(angle),
      p[1] + u[1] * Math.cos(angle) + v[1] * Math.sin(angle), p[2] + u[2] * Math.cos(angle) + v[2] * Math.sin(angle)];
    for (let i = 0; i < 8; i++) this.quad(ring(a, i * TAU / 8), ring(b, i * TAU / 8),
      ring(b, (i + 1) * TAU / 8), ring(a, (i + 1) * TAU / 8), albedo, 0.16);
  }

  mesh(): AsciiMesh {
    return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices), materials: this.materials };
  }
}

export function createSatelliteScene(cols: number, rows: number) {
  const raster = new AsciiMeshRaster(cols, rows, { aspect: 2, centerY: 0.62, perspective: 0.055 });
  const unit = Math.min(raster.width / 8.6, raster.height / 3.6);
  return {
    frame(seconds: number): AsciiAnimationFrame {
      const idle = Math.max(0, seconds - 3.2);
      const view = rotationMatrix(-0.32 + Math.sin(idle * TAU / 16) * 0.18, 0.23, -0.1);
      const mesh = new Mesh();
      mesh.box([0, 0, 0], [0.68, 0.67, 0.55], 1.03);
      mesh.box([0, 0, 0.285], [0.49, 0.48, 0.03], 0.4);
      mesh.box([0, -0.2, 0.309], [0.34, 0.032, 0.025], 1.1);
      mesh.box([0, 0.2, 0.309], [0.34, 0.032, 0.025], 1.1);
      for (let i = 0; i < 3; i++) mesh.box([-0.11 + i * 0.11, 0.035, 0.308], [0.026, 0.19, 0.02], 0.8);
      mesh.box([0, 0.37, 0], [0.24, 0.09, 0.32], 0.55);

      for (const side of [-1, 1]) {
        const deployed = smooth((seconds - 0.45 - (side === 1 ? 0.22 : 0)) / 2.45);
        const fold = (1 - deployed) * 1.4;
        const panel = (p: Point): Point => [side * (0.53 + p[0] * Math.cos(fold) - p[2] * Math.sin(fold)), side * p[1], p[0] * Math.sin(fold) + p[2] * Math.cos(fold)];
        mesh.rod([side * 0.3, 0, 0], [side * 0.57, 0, 0], 0.026);
        mesh.box([0.61, 0, 0], [1.23, 0.8, 0.035], 0.22, 0.07, panel);
        for (const y of [-0.4, 0.4]) mesh.box([0.61, y, 0.027], [1.25, 0.05, 0.025], 1.1, 0.8, panel);
        for (const x of [0, 0.31, 0.62, 0.93, 1.24]) mesh.box([x, 0, 0.028], [0.047, 0.81, 0.025], 0.9, 0.7, panel);
        mesh.box([0.62, 0, 0.028], [1.25, 0.043, 0.025], 0.9, 0.7, panel);
      }

      const dishTilt = rotationMatrix(0.22, 0.28 + smooth(seconds / 2.2) * 0.72, 0);
      const dish = (p: Point): Point => { const q = rotate(p, dishTilt); return [q[0], q[1] - 0.61, q[2] + 0.17]; };
      mesh.rod([0, -0.29, 0], dish([0, 0, -0.055]), 0.035);
      const dishPoint = (radius: number, angle: number, back = false): Point => dish([
        Math.cos(angle) * radius, Math.sin(angle) * radius, 0.18 * (radius / 0.37) ** 2 - (back ? 0.025 : 0),
      ]);
      for (let ring = 0; ring < 7; ring++) {
        const inner = ring / 7 * 0.37, outer = (ring + 1) / 7 * 0.37;
        for (let segment = 0; segment < 40; segment++) {
          const a = segment * TAU / 40, b = (segment + 1) * TAU / 40;
          mesh.quad(dishPoint(inner, a), dishPoint(outer, a), dishPoint(outer, b), dishPoint(inner, b), 1.05);
          mesh.quad(dishPoint(inner, b, true), dishPoint(outer, b, true), dishPoint(outer, a, true), dishPoint(inner, a, true), 0.72);
        }
      }
      for (let segment = 0; segment < 40; segment++) mesh.rod(dishPoint(0.37, segment * TAU / 40), dishPoint(0.37, (segment + 1) * TAU / 40), 0.012, 1.15);
      for (let spoke = 0; spoke < 3; spoke++) mesh.rod(dishPoint(0.34, spoke * TAU / 3), dish([0, 0, 0.39]), 0.012, 0.9);
      mesh.rod(dish([0, 0, 0.34]), dish([0, 0, 0.46]), 0.036, 0.9);

      raster.clear();
      raster.mesh(mesh.mesh(), view, unit);
      if (seconds > 3.5) {
        const pulse = (seconds - 3.5) % 4;
        for (let wave = 0; wave < 2; wave++) {
          const progress = (pulse - wave * 0.23) / 1.4;
          if (progress < 0 || progress > 1) continue;
          const radius = 0.13 + progress * 0.23;
          const brightness = Math.sin(progress * Math.PI) * 0.7;
          for (let segment = 0; segment <= 64; segment++) {
            const angle = Math.PI * (1.07 + segment / 64 * 0.86);
            const p = rotate(dish([Math.cos(angle) * radius, Math.sin(angle) * radius, 0.55 + progress * 0.8]), view);
            const perspective = 1 + p[2] * 0.055;
            raster.splat(raster.width / 2 + p[0] * unit * 2 * perspective, raster.height * 0.62 + p[1] * unit * perspective,
              p[2], brightness, 0.85);
          }
        }
      }
      return raster.frame("dark");
    },
  };
}
