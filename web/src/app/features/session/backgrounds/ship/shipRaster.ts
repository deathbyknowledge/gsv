import type { ShipMesh } from "./wayfarer";

export function rotationMatrix(yaw: number, pitch: number, roll: number): number[] {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  return [cr * cy - sr * sp * sy, -sr * cp, cr * sy + sr * sp * cy, sr * cy + cr * sp * sy, cr * cp, sr * sy - cr * sp * cy, -cp * sy, sp, cp * cy];
}

/** Render geometry at a fixed resolution, then average coverage into glyphs. */
export class ShipRaster {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Float32Array;
  private readonly depth: Float32Array;
  private readonly cells: Float32Array;
  private projected = new Float32Array(0);

  constructor(private readonly cols: number, private readonly rows: number) {
    this.width = cols * 2;
    this.height = rows * 2;
    this.pixels = new Float32Array(this.width * this.height);
    this.depth = new Float32Array(this.pixels.length);
    this.cells = new Float32Array(cols * rows);
  }

  clear(): void {
    this.pixels.fill(0);
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
      }
    }
  }

  mesh(mesh: ShipMesh, matrix: number[], unit: number, bob: number, ignition: number, opacity: number): void {
    const vertices = mesh.vertices;
    if (this.projected.length !== vertices.length) this.projected = new Float32Array(vertices.length);
    const projected = this.projected;
    for (let index = 0; index < vertices.length; index += 6) {
      const px = vertices[index], py = vertices[index + 1] + bob, pz = vertices[index + 2];
      const x = matrix[0] * px + matrix[1] * py + matrix[2] * pz;
      const y = matrix[3] * px + matrix[4] * py + matrix[5] * pz;
      const z = matrix[6] * px + matrix[7] * py + matrix[8] * pz;
      const perspective = 1 + z * 0.045;
      projected[index] = this.width * 0.47 + x * unit * 1.62 * perspective;
      projected[index + 1] = this.height * 0.49 + y * unit * perspective;
      projected[index + 2] = z;
      const nx = matrix[0] * vertices[index + 3] + matrix[1] * vertices[index + 4] + matrix[2] * vertices[index + 5];
      const ny = matrix[3] * vertices[index + 3] + matrix[4] * vertices[index + 4] + matrix[5] * vertices[index + 5];
      const nz = matrix[6] * vertices[index + 3] + matrix[7] * vertices[index + 4] + matrix[8] * vertices[index + 5];
      projected[index + 3] = 0.23 + Math.max(0, -0.37 * nx - 0.66 * ny + 0.66 * nz) * 0.63 + Math.pow(1 - Math.min(1, Math.abs(nz)), 3) * 0.14;
    }
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const material = mesh.materials[index / 3];
      this.triangle(mesh.indices[index] * 6, mesh.indices[index + 1] * 6, mesh.indices[index + 2] * 6, material.albedo, material.emission * ignition, opacity);
    }
  }

  private triangle(a: number, b: number, c: number, albedo: number, emission: number, opacity: number): void {
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
        this.pixels[index] = brightness * opacity;
      }
    }
  }

  resolve(): Float32Array {
    for (let row = 0; row < this.rows; row++) {
      for (let column = 0; column < this.cols; column++) {
        const index = row * 2 * this.width + column * 2;
        this.cells[row * this.cols + column] = (this.pixels[index] + this.pixels[index + 1] + this.pixels[index + this.width] + this.pixels[index + this.width + 1]) / 4;
      }
    }
    return this.cells;
  }
}
