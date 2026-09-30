import type { AsciiMaterial, AsciiMesh } from "../../../../components/ui/asciiMesh";

type Vector = [number, number, number];
export type VoyagerPoint = {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  brightness: number; delay: number; flicker?: number;
};
type VoyagerModel = { mesh: AsciiMesh; points: VoyagerPoint[]; details: VoyagerPoint[] };

/** Original Voyager from the local shape study: a swept-wing hull and twin drives. */
export function buildVoyager(): VoyagerModel {
  let state = 1701;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  const tau = Math.PI * 2;
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 0.00001))) * Math.cos(tau * random());
  const points: VoyagerPoint[] = [];
  const details: VoyagerPoint[] = [];
  const vertices: number[] = [], indices: number[] = [], materials: AsciiMaterial[] = [];
  const face = (a: Vector, b: Vector, c: Vector, albedo: number, emission = 0, center: Vector = [0, 0, 0]) => {
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const outward = n.reduce((sum, value, axis) => sum + value * ((a[axis] + b[axis] + c[axis]) / 3 - center[axis]), 0);
    const length = Math.hypot(...n) * (outward < 0 ? -1 : 1);
    const unit = n.map((value) => value / length);
    const base = vertices.length / 6;
    for (const point of [a, b, c]) vertices.push(...point, ...unit);
    indices.push(base, base + 1, base + 2);
    materials.push({ albedo, emission });
  };
  const add = (x: number, y: number, z: number, brightness = 0.65) => {
    const angle = random() * tau;
    // Taper density toward the cloud's edge and fit it inside the view at every angle.
    const distance = 1.2 * Math.sqrt(1 - Math.sqrt(1 - random()));
    const depth = normal() * 0.32;
    const extent = Math.max(1, Math.hypot(distance, depth) / 1.2);
    const point: VoyagerPoint = { x, y, z, brightness, sx: Math.cos(angle) * distance / extent,
      sy: Math.sin(angle) * distance / extent, sz: depth / extent, delay: random() * 0.65 };
    points.push(point);
    return point;
  };
  const edge = (a: Vector, b: Vector, brightness = 0.86, detail = false) => {
    const count = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 130);
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const point = add(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, brightness);
      if (detail) details.push(point);
    }
  };
  const triangle = (a: Vector, b: Vector, c: Vector, brightness: number, count = 350) => {
    face(a, b, c, 0.75 + brightness * 0.55);
    for (let i = 0; i < count; i++) {
      const u = Math.sqrt(random()), v = random();
      const wa = 1 - u, wb = u * (1 - v), wc = u * v;
      add(a[0] * wa + b[0] * wb + c[0] * wc, a[1] * wa + b[1] * wb + c[1] * wc,
        a[2] * wa + b[2] * wb + c[2] * wc, brightness + random() * 0.1);
    }
    edge(a, b); edge(b, c); edge(c, a);
  };
  const nose: Vector = [0, -1.3, 0.015], ridge: Vector = [0, -0.33, 0.19];
  const back: Vector = [0, 0.72, 0.14], keel: Vector = [0, 0.3, -0.13];
  for (const side of [-1, 1]) {
    const front: Vector = [side * 0.17, -0.37, 0.015], rear: Vector = [side * 0.21, 0.67, 0.015];
    triangle(nose, front, ridge, 0.58);
    triangle(front, rear, ridge, 0.45);
    triangle(rear, ridge, back, 0.63);
    triangle(nose, front, keel, 0.28);
    triangle(front, rear, keel, 0.24);
    triangle(rear, back, keel, 0.34);
    const wingTip: Vector = [side * 1.06, 0.61, 0.045], wingBack: Vector = [side * 0.84, 0.83, 0.015];
    triangle(front, wingTip, rear, 0.4, 550);
    triangle(wingTip, wingBack, rear, 0.55, 300);
    edge([side * 0.31, 0.04, 0.052], [side * 0.81, 0.57, 0.055], 0.96, true);
    triangle([side * 0.12, 0.36, 0.09], [side * 0.16, 0.71, 0.4], [side * 0.19, 0.77, 0.035], 0.57, 220);
    const center: Vector = [side * 0.47, 0.535, 0.055];
    const ring = (angle: number, y: number, radius = 0.105): Vector => [center[0] + Math.cos(angle) * radius, y, center[2] + Math.sin(angle) * radius];
    for (let segment = 0; segment < 24; segment++) {
      const a = segment / 24 * tau, b = (segment + 1) / 24 * tau;
      face(ring(a, 0.23), ring(b, 0.23), ring(b, 0.84), 0.9, 0, center);
      face(ring(a, 0.23), ring(b, 0.84), ring(a, 0.84), 0.9, 0, center);
      face([center[0], 0.23, center[2]], ring(a, 0.23), ring(b, 0.23), 0.5, 0, center);
      face([center[0], 0.86, center[2]], ring(a, 0.86, 0.092), ring(b, 0.86, 0.092), 0.9, 0.95, center);
    }
    for (let i = 0; i < 1100; i++) {
      const angle = random() * tau, t = random();
      add(side * 0.47 + Math.cos(angle) * 0.105, 0.23 + t * 0.61,
        0.055 + Math.sin(angle) * 0.105, 0.35 + 0.25 * (Math.cos(angle) + 1) / 2);
    }
    for (let i = 0; i < 380; i++) {
      const angle = random() * tau;
      add(side * 0.47 + Math.cos(angle) * 0.092, 0.86, 0.055 + Math.sin(angle) * 0.092, 0.99);
    }
    for (let i = 0; i < 650; i++) {
      const length = random(), width = 0.057 * (1 - length * 0.8);
      const point = add(side * 0.47 + normal() * width, 0.88 + length * 0.54, 0.055 + normal() * width,
        0.9 * (1 - length) + 0.12);
      point.flicker = random() * tau;
      details.push(point);
    }
  }
  triangle([0, -0.67, 0.15], [-0.095, -0.27, 0.198], [0.095, -0.27, 0.198], 0.9, 300);
  edge([0, -0.62, 0.16], [0, 0.45, 0.205], 0.96, true);
  return { mesh: { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), materials }, points, details };
}
