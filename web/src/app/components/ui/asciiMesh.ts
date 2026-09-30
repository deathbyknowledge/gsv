import type { AsciiAnimationFrame } from "./AsciiAnimation";
import type { ColorTheme } from "./useColorTheme";

export type AsciiMaterial = { albedo: number; emission: number };
export type AsciiMesh = { vertices: Float32Array; indices: Uint32Array; materials: AsciiMaterial[] };
export type AsciiGlowPoint = { x: number; y: number; z: number; radius: number; brightness: number };
type Projection = { centerX?: number; centerY?: number; aspect?: number; perspective?: number };


const RAMP = " .,:;irsXA253hMHGS#9B&@";
const INK_RAMP = " .,:;-=+xX%#@";

type AsciiCells = { light: Float32Array; coverage: Float32Array };

export function rotationMatrix(yaw: number, pitch: number, roll: number): number[] {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  return [cr * cy - sr * sp * sy, -sr * cp, cr * sy + sr * sp * cy, sr * cy + cr * sp * sy, cr * cp, sr * sy - cr * sp * cy, -cp * sy, sp, cp * cy];
}

/** Render geometry at a fixed resolution, then average coverage into glyphs. */
export class AsciiMeshRaster {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Float32Array;
  private readonly coverage: Float32Array;
  private readonly depth: Float32Array;
  private readonly cells: AsciiCells;
  private projected = new Float32Array(0);
  private readonly centerX: number;
  private readonly centerY: number;
  private readonly aspect: number;
  private readonly perspective: number;

  constructor(private readonly cols: number, private readonly rows: number, projection: Projection = {}) {
    this.width = cols * 2;
    this.height = rows * 2;
    this.centerX = this.width * (projection.centerX ?? 0.5);
    this.centerY = this.height * (projection.centerY ?? 0.5);
    this.aspect = projection.aspect ?? 11 / 7;
    this.perspective = projection.perspective ?? 0.035;
    this.pixels = new Float32Array(this.width * this.height);
    this.coverage = new Float32Array(this.pixels.length);
    this.depth = new Float32Array(this.pixels.length);
    this.cells = { light: new Float32Array(cols * rows), coverage: new Float32Array(cols * rows) };
  }

  clear(): void {
    this.pixels.fill(0);
    this.coverage.fill(0);
    this.depth.fill(-Infinity);
  }

  splat(x: number, y: number, z: number, brightness: number, radius = 1.25): void {
    const left = Math.max(0, Math.ceil(x - radius - 0.5));
    const right = Math.min(this.width - 1, Math.floor(x + radius - 0.5));
    const top = Math.max(0, Math.ceil(y - radius - 0.5));
    const bottom = Math.min(this.height - 1, Math.floor(y + radius - 0.5));
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const coverage = Math.min(1, Math.max(0, radius + 0.35 - Math.hypot(column + 0.5 - x, row + 0.5 - y)));
        const index = row * this.width + column;
        if (!coverage || z < this.depth[index]) continue;
        this.depth[index] = z;
        this.pixels[index] = brightness * coverage;
        this.coverage[index] = coverage;
      }
    }
  }

  mesh(mesh: AsciiMesh, matrix: number[], unit: number, bob = 0, ignition = 1,
    translation: readonly [number, number, number] = [0, 0, 0]): void {
    const vertices = mesh.vertices;
    if (this.projected.length !== vertices.length) this.projected = new Float32Array(vertices.length);
    const projected = this.projected;
    for (let index = 0; index < vertices.length; index += 6) {
      const px = vertices[index], py = vertices[index + 1] + bob, pz = vertices[index + 2];
      const x = matrix[0] * px + matrix[1] * py + matrix[2] * pz + translation[0];
      const y = matrix[3] * px + matrix[4] * py + matrix[5] * pz + translation[1];
      const z = matrix[6] * px + matrix[7] * py + matrix[8] * pz + translation[2];
      const perspective = 1 + z * this.perspective;
      projected[index] = this.centerX + x * unit * this.aspect * perspective;
      projected[index + 1] = this.centerY + y * unit * perspective;
      projected[index + 2] = z;
      const nx = matrix[0] * vertices[index + 3] + matrix[1] * vertices[index + 4] + matrix[2] * vertices[index + 5];
      const ny = matrix[3] * vertices[index + 3] + matrix[4] * vertices[index + 4] + matrix[5] * vertices[index + 5];
      const nz = matrix[6] * vertices[index + 3] + matrix[7] * vertices[index + 4] + matrix[8] * vertices[index + 5];
      projected[index + 3] = 0.25 + Math.max(0, -0.42 * nx - 0.69 * ny + 0.58 * nz) * 0.65 + Math.pow(1 - Math.min(1, Math.abs(nz)), 3) * 0.1;
    }
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const material = mesh.materials[index / 3];
      this.triangle(mesh.indices[index] * 6, mesh.indices[index + 1] * 6, mesh.indices[index + 2] * 6, material.albedo, material.emission * ignition);
    }
  }

  glow(points: AsciiGlowPoint[], matrix: number[], unit: number, bob: number, ignition: number): void {
    for (const point of points) {
      const brightness = point.brightness * ignition;
      if (brightness < 0.01) continue;
      const py = point.y + bob;
      const x = matrix[0] * point.x + matrix[1] * py + matrix[2] * point.z;
      const y = matrix[3] * point.x + matrix[4] * py + matrix[5] * point.z;
      const z = matrix[6] * point.x + matrix[7] * py + matrix[8] * point.z;
      const perspective = 1 + z * this.perspective;
      const cx = this.centerX + x * unit * this.aspect * perspective;
      const cy = this.centerY + y * unit * perspective;
      const radius = point.radius * unit * perspective;
      const left = Math.max(0, Math.ceil(cx - radius * this.aspect - 0.5));
      const right = Math.min(this.width - 1, Math.floor(cx + radius * this.aspect - 0.5));
      const top = Math.max(0, Math.ceil(cy - radius - 0.5));
      const bottom = Math.min(this.height - 1, Math.floor(cy + radius - 0.5));
      for (let row = top; row <= bottom; row++) {
        for (let column = left; column <= right; column++) {
          const index = row * this.width + column;
          if (z < this.depth[index]) continue;
          const distance = Math.hypot((column + 0.5 - cx) / this.aspect, row + 0.5 - cy) / radius;
          if (distance >= 1) continue;
          const light = brightness * (1 - distance * distance);
          // Light respects the hull's depth without obscuring it or building an opaque exhaust surface.
          this.pixels[index] = Math.max(this.pixels[index], light);
        }
      }
    }
  }

  private triangle(a: number, b: number, c: number, albedo: number, emission: number): void {
    const vertices = this.projected;
    const ax = vertices[a], ay = vertices[a + 1], bx = vertices[b], by = vertices[b + 1], cx = vertices[c], cy = vertices[c + 1];
    const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(area) < 0.000001) return;
    const left = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const right = Math.min(this.width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const top = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const bottom = Math.min(this.height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    const inverse = 1 / area;
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const wa = ((by - cy) * (column + 0.5 - cx) + (cx - bx) * (row + 0.5 - cy)) * inverse;
        const wb = ((cy - ay) * (column + 0.5 - cx) + (ax - cx) * (row + 0.5 - cy)) * inverse;
        const wc = 1 - wa - wb;
        if (wa < -0.000001 || wb < -0.000001 || wc < -0.000001) continue;
        const index = row * this.width + column;
        const z = vertices[a + 2] * wa + vertices[b + 2] * wb + vertices[c + 2] * wc;
        if (z < this.depth[index]) continue;
        const brightness = Math.min(1, Math.max((vertices[a + 3] * wa + vertices[b + 3] * wb + vertices[c + 3] * wc) * albedo, emission));
        this.depth[index] = z;
        this.pixels[index] = brightness;
        this.coverage[index] = 1;
      }
    }
  }

  /** At zero retain the particles; at one retain this complete surface render. */
  crossfadeFrom(source: AsciiMeshRaster, amount: number): void {
    for (let index = 0; index < this.pixels.length; index++) {
      this.pixels[index] = source.pixels[index] * (1 - amount) + this.pixels[index] * amount;
      this.coverage[index] = source.coverage[index] * (1 - amount) + this.coverage[index] * amount;
      this.depth[index] = Math.max(source.depth[index], this.depth[index]);
    }
  }

  resolve(): AsciiCells {
    for (let row = 0; row < this.rows; row++) {
      for (let column = 0; column < this.cols; column++) {
        const index = row * 2 * this.width + column * 2;
        const cell = row * this.cols + column;
        this.cells.light[cell] = (this.pixels[index] + this.pixels[index + 1] + this.pixels[index + this.width] + this.pixels[index + this.width + 1]) / 4;
        this.cells.coverage[cell] = (this.coverage[index] + this.coverage[index + 1] + this.coverage[index + this.width] + this.coverage[index + this.width + 1]) / 4;
      }
    }
    return this.cells;
  }

  frame(palette: ColorTheme = "dark"): AsciiAnimationFrame {
    const cells = this.resolve();
    const ink = palette === "light";
    const ramp = ink ? INK_RAMP : RAMP;
    const material: string[] = [], dust: string[] = [], highlights: string[] = [];
    for (let row = 0; row < this.rows; row++) {
      let foreground = "", nebula = "", stars = "";
      for (let column = 0; column < this.cols; column++) {
        const cell = row * this.cols + column;
        const light = cells.light[cell];
        const coverage = cells.coverage[cell];
        let tone = light;
        let density = light;
        if (ink) {
          if (coverage > 0) {
            const shade = Math.max(0, Math.min(1, 1 - light / coverage));
            // Pale faces keep substantial strokes; geometry coverage softens their edges.
            tone = Math.max(0.09, shade);
            density = coverage * (0.55 + (1 - 0.55) * shade);
          } else {
            // Empty space stays blank and exhaust retains its soft falloff.
            tone = light * 0.18;
            density = tone;
          }
        }
        const glyph = ramp[Math.min(ramp.length - 1, Math.floor(density * ramp.length))];
        nebula += tone > 0.06 && tone < 0.35 ? glyph : " ";
        foreground += tone >= 0.35 && tone < 0.8 ? glyph : " ";
        stars += tone >= 0.8 ? glyph : " ";
      }
      material.push(foreground);
      dust.push(nebula);
      highlights.push(stars);
    }
    return { foreground: material.join("\n"), nebula: dust.join("\n"), stars: highlights.join("\n") };
  }
}
