/** Original Open Country geometry from the GSV shape study; no external model assets. */
type Vector = [number, number, number];
type Section = [number, number, number, number, number];
type Material = { albedo: number; emission: number };
type MaterialName = keyof typeof MATERIALS;
export type ShipMesh = { vertices: Float32Array; indices: Uint32Array; materials: Material[] };
export type ShipPoint = Material & {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  sx: number; sy: number; sz: number;
  delay: number; noise: number;
};
export type ShipGlowPoint = { x: number; y: number; z: number; radius: number; brightness: number };
export type ShipModel = { mesh: ShipMesh; points: ShipPoint[]; driveGlow: ShipGlowPoint[] };

const TAU = Math.PI * 2;
const MATERIALS = {
  hull: { albedo: 0.92, emission: 0 },
  ceramic: { albedo: 1.12, emission: 0 },
  recess: { albedo: 0.3, emission: 0 },
  structure: { albedo: 0.56, emission: 0 },
  park: { albedo: 0.77, emission: 0 },
  water: { albedo: 0.38, emission: 0 },
  light: { albedo: 0.9, emission: 0.88 },
  drive: { albedo: 0.8, emission: 1 },
};
const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (vector: Vector): Vector => {
  const length = Math.hypot(...vector) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

export function buildOpenCountry(drivesOn: boolean): ShipModel {
  const vertices: number[] = [], indices: number[] = [], materials: Material[] = [];
  const driveGlow: ShipGlowPoint[] = [];
  function face(corners: Vector[], material: MaterialName): void {
    const normal = unit(cross(subtract(corners[1], corners[0]), subtract(corners[2], corners[0])));
    const base = vertices.length / 6;
    for (const corner of corners) vertices.push(...corner, ...normal);
    for (let index = 1; index < corners.length - 1; index++) {
      indices.push(base, base + index, base + index + 1);
      materials.push(material === "drive" && !drivesOn ? MATERIALS.recess : MATERIALS[material]);
    }
  }
  function solid(points: Vector[], polygons: number[][], material: MaterialName): void {
    const center: Vector = [0, 0, 0];
    for (const point of points) for (let axis = 0; axis < 3; axis++) center[axis] += point[axis] / points.length;
    for (const polygon of polygons) {
      const corners = polygon.map((index) => points[index]);
      const normal = cross(subtract(corners[1], corners[0]), subtract(corners[2], corners[0]));
      const outward = subtract(corners[0], center);
      if (normal.reduce((sum, value, axis) => sum + value * outward[axis], 0) < 0) corners.reverse();
      face(corners, material);
    }
  }
  function plate(center: Vector, length: number, width: number, height: number, bevel: number, material: MaterialName): void {
    const x = length / 2, z = width / 2, b = Math.min(bevel, x, z);
    const outline = [[-x + b, -z], [x - b, -z], [x, -z + b], [x, z - b], [x - b, z], [-x + b, z], [-x, z - b], [-x, -z + b]];
    const points = [-1, 1].flatMap((side) => outline.map(([px, pz]): Vector => [center[0] + px, center[1] + side * height / 2, center[2] + pz]));
    const polygons = [Array.from({ length: 8 }, (_, i) => i), Array.from({ length: 8 }, (_, i) => i + 8)];
    for (let i = 0; i < 8; i++) polygons.push([i, (i + 1) % 8, (i + 1) % 8 + 8, i + 8]);
    solid(points, polygons, material);
  }
  function box(center: Vector, size: Vector, material: MaterialName): void {
    const [x, y, z] = size.map((value) => value / 2);
    const points = [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z]]
      .map(([px, py, pz]): Vector => [px + center[0], py + center[1], pz + center[2]]);
    solid(points, [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], material);
  }
  function beam(start: Vector, end: Vector, width: number, material: MaterialName): void {
    const along = unit(subtract(end, start));
    const across = unit(cross(along, Math.abs(along[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]));
    const up = cross(along, across);
    const points: Vector[] = [];
    for (const center of [start, end]) {
      for (const [side, vertical] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const corner: Vector = [...center];
        for (let axis = 0; axis < 3; axis++) corner[axis] += (across[axis] * side + up[axis] * vertical) * width / 2;
        points.push(corner);
      }
    }
    solid(points, [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], material);
  }
  function sectionedBody(sections: Section[], profile: Array<[number, number]>, material: MaterialName): void {
    const segments = profile.length;
    const rings = sections.map(([x, y, z, ry, rz]) => profile.map(([py, pz]): Vector => [x, y + py * ry, z + pz * rz]));
    const polygons: number[][] = [];
    for (let section = 0; section < rings.length - 1; section++) {
      for (let index = 0; index < segments; index++) polygons.push([section * segments + index, section * segments + (index + 1) % segments, (section + 1) * segments + (index + 1) % segments, (section + 1) * segments + index]);
    }
    polygons.push(Array.from({ length: segments }, (_, i) => i), Array.from({ length: segments }, (_, i) => (rings.length - 1) * segments + i));
    solid(rings.flat(), polygons, material);
  }
  function loft(sections: Section[], material: MaterialName): void {
    sectionedBody(sections, Array.from({ length: 24 }, (_, index): [number, number] => [Math.cos(index / 24 * TAU), Math.sin(index / 24 * TAU)]), material);
  }
  function hull(sections: Section[], material: MaterialName): void {
    sectionedBody(sections, [[-1, -0.85], [-0.5, -1], [0.55, -1], [1, -0.75], [1, 0.75], [0.55, 1], [-0.5, 1], [-1, 0.85]], material);
  }
  function drive(mouth: Vector, radius: number): void {
    const [x, y, z] = mouth;
    const length = 1.43;
    loft([
      [x - length, y, z, radius * 0.24, radius * 0.35],
      [x - length * 0.68, y, z, radius * 0.83, radius * 0.92],
      [x - radius * 0.64, y, z, radius * 0.88, radius * 0.88],
    ], "hull");
    const segments = 24;
    const ring = (px: number, size: number): Vector[] => Array.from({ length: segments }, (_, index): Vector => [px, y + Math.cos(index / segments * TAU) * radius * size, z + Math.sin(index / segments * TAU) * radius * size]);
    const base = ring(x - radius * 0.65, 0.88);
    const outer = ring(x, 1.05);
    const inner = ring(x, 0.79);
    const throat = ring(x - radius * 0.38, 0.62);
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      face([base[i], base[next], outer[next], outer[i]], "structure");
      face([outer[i], outer[next], inner[next], inner[i]], "ceramic");
      face([inner[i], inner[next], throat[next], throat[i]], "recess");
    }
    face(throat, "drive");
    for (const side of [-1, 1]) beam([x - length * 0.65, y - radius * 0.28, z + side * radius * 0.9], [x - radius * 0.75, y - radius * 0.28, z + side * radius * 0.9], 0.025, "light");
    if (drivesOn) {
      for (let i = 0; i < 24; i++) {
        const distance = i / 23;
        driveGlow.push({
          x: x + 0.015 + distance * 0.56, y, z,
          radius: radius * (0.52 - distance * 0.32),
          brightness: 0.98 * Math.pow(1 - distance, 0.7),
        });
      }
    }
  }
  function landscape(): void {
    const cols = 22, rows = 12;
    const heightAt = (u: number, v: number) => Math.max(0, Math.sin(u * 9 + 0.5) * Math.cos(v * 7 - 0.5) + Math.sin(u * 17 + v * 11) * 0.35 - 0.15) * 0.15;
    const point = (u: number, v: number): Vector => [-0.03 + (u - 0.5) * 4.2, -0.276 - heightAt(u, v), (v - 0.5) * 1.65];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const u = col / cols, v = row / rows;
        const height = heightAt(u + 0.5 / cols, v + 0.5 / rows);
        face([point(u, v), point(u + 1 / cols, v), point(u + 1 / cols, v + 1 / rows), point(u, v + 1 / rows)], height > 0.09 ? "ceramic" : height > 0.01 ? "park" : "water");
      }
    }
  }
  function city(x: number, z: number, count: number, seed: number): void {
    const rand = random(seed);
    for (let i = 0; i < count; i++) {
      const px = x + (rand() - 0.5) * 0.7, pz = z + (rand() - 0.5) * 0.24;
      const height = 0.035 + rand() * 0.1;
      box([px, -0.28 - height / 2, pz], [0.025 + rand() * 0.035, height, 0.025 + rand() * 0.025], "ceramic");
    }
  }

  // The bow and broad shoulders enclose the landscape rather than extending it as a flat slab.
  hull([[-3.03, 0.22, 0, 0.025, 0.09], [-2.1, 0.29, 0, 0.25, 1.02], [1.75, 0.29, 0, 0.3, 1.02], [2.61, 0.24, 0, 0.22, 0.89]], "structure");
  hull([[-3.35, 0.05, 0, 0.055, 0.13], [-2.38, 0.055, 0, 0.265, 1.22], [-1.7, 0.07, 0, 0.3, 1.4], [1.68, 0.07, 0, 0.3, 1.4], [2.56, 0.1, 0, 0.22, 1.12]], "hull");
  plate([-0.03, -0.245, 0], 4.62, 2.1, 0.055, 0.3, "ceramic");
  landscape();
  for (const side of [-1, 1]) {
    beam([-2.1, -0.28, side * 1.01], [2.04, -0.28, side * 1.01], 0.025, "light");
    beam([-3.19, 0.035, side * 0.19], [-1.7, -0.065, side * 1.4], 0.045, "ceramic");
    beam([-1.69, -0.065, side * 1.409], [1.68, -0.065, side * 1.409], 0.055, "recess");
    for (let i = 0; i < 17; i++) {
      const x = -1.62 + i * 0.2;
      box([x, 0.065, side * 1.402], [0.135, 0.12, 0.015], "recess");
      box([x, 0.065, side * 1.413], [0.083, 0.017, 0.009], "light");
    }
    for (let i = 0; i < 7; i++) box([-2.1 + i * 0.69, 0.53, side * 0.73], [0.38, 0.2, 0.14], "hull");
    city(-1.1, side * 0.81, 24, side < 0 ? 71 : 93);
    city(1.35, side * 0.81, 22, side < 0 ? 52 : 18);
    beam([-2.63, -0.45, side * 0.33], [-2.11, -0.45, side * 0.33], 0.035, "light");
  }
  loft([[-2.85, -0.19, 0, 0.02, 0.07], [-2.5, -0.35, 0, 0.15, 0.46], [-2.01, -0.35, 0, 0.13, 0.38], [-1.75, -0.27, 0, 0.025, 0.17]], "ceramic");
  plate([-2.35, -0.486, 0], 0.53, 0.64, 0.025, 0.1, "recess");
  plate([2.34, 0.15, 0], 0.61, 1.95, 0.42, 0.13, "structure");

  // Wider, shallower apertures keep the three separate drives legible in the compact glyph view.
  for (const side of [-1, 0, 1]) drive([3.16, 0.23, side * 0.92], side === 0 ? 0.37 : 0.34);

  const mesh: ShipMesh = { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), materials };
  let area = 0;
  const distribution = materials.map((material, faceIndex) => {
    const corners = indices.slice(faceIndex * 3, faceIndex * 3 + 3).map((index): Vector => [vertices[index * 6], vertices[index * 6 + 1], vertices[index * 6 + 2]]);
    area += Math.hypot(...cross(subtract(corners[1], corners[0]), subtract(corners[2], corners[0]))) / 2 * (material.emission ? 4 : 1);
    return area;
  });
  const rand = random(17092026);
  const points: ShipPoint[] = [];
  for (let sample = 0; sample < 16000; sample++) {
    const target = rand() * area;
    let low = 0, high = distribution.length - 1;
    while (low < high) { const middle = (low + high) >>> 1; if (distribution[middle] < target) low = middle + 1; else high = middle; }
    const u = Math.sqrt(rand()), v = rand(), weights = [1 - u, u * (1 - v), u * v];
    const p = Array.from({ length: 6 }, (_, axis) => weights.reduce((sum, weight, corner) => sum + mesh.vertices[mesh.indices[low * 3 + corner] * 6 + axis] * weight, 0));
    const angle = rand() * TAU, distance = 2.8 + rand() * 3.2;
    points.push({ x: p[0], y: p[1], z: p[2], nx: p[3], ny: p[4], nz: p[5], ...materials[low], sx: Math.cos(angle) * distance, sy: Math.sin(angle) * distance * 0.5, sz: (rand() - 0.5) * 4, delay: rand() * 0.8, noise: rand() });
  }
  return { mesh, points, driveGlow };
}
