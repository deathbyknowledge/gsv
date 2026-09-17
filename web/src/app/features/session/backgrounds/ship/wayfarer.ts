/** Original Wayfarer geometry from the GSV shape study; no external model assets. */
type Vector = [number, number, number];
type Material = { albedo: number; emission: number };
type MaterialName = keyof typeof MATERIALS;
type Face = { indices: [number, number, number]; material: MaterialName; group: string };
export type ShipMesh = { vertices: Float32Array; indices: Uint32Array; materials: Material[] };
export type ShipPoint = Material & {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  sx: number; sy: number; sz: number;
  delay: number; noise: number; exhaust: boolean; phase: number;
};
export type ShipModel = { mesh: ShipMesh; points: ShipPoint[]; exhaust: ShipPoint[] };

const TAU = Math.PI * 2;
const MATERIALS = {
  hull: { albedo: .94, emission: 0 },
  ceramic: { albedo: 1.12, emission: 0 },
  structure: { albedo: .66, emission: 0 },
  radiator: { albedo: .46, emission: 0 },
  glass: { albedo: .37, emission: 0 },
  windows: { albedo: 1, emission: .9 },
  drive: { albedo: 1, emission: 1 },
};

const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (vector: Vector): Vector => { const length = Math.hypot(...vector) || 1; return [vector[0] / length, vector[1] / length, vector[2] / length]; };

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

export function buildWayfarer(): ShipModel {
  const vertices: Vector[] = [];
  const faces: Face[] = [];
  const vertex = (position: Vector) => { vertices.push(position); return vertices.length - 1; };
  const triangle = (a: number, b: number, c: number, material: MaterialName, group: string) => faces.push({ indices: [a, b, c], material, group });
  const quad = (a: number, b: number, c: number, d: number, material: MaterialName, group: string) => { triangle(a, b, c, material, group); triangle(a, c, d, material, group); };

  function loft(group: string, sections: Array<[number, number, number, number, number]>, material: MaterialName = "hull", segments = 20) {
    const rings = sections.map(([x, y, z, ry, rz]) => Array.from({ length: segments }, (_, index) => {
      const angle = index / segments * TAU;
      return vertex([x, y + Math.cos(angle) * ry, z + Math.sin(angle) * rz]);
    }));
    for (let section = 0; section < rings.length - 1; section++) {
      for (let index = 0; index < segments; index++) {
        const next = (index + 1) % segments;
        quad(rings[section][index], rings[section][next], rings[section + 1][next], rings[section + 1][index], material, group);
      }
    }
    const first = sections[0], last = sections[sections.length - 1];
    const front = vertex([first[0], first[1], first[2]]);
    const rear = vertex([last[0], last[1], last[2]]);
    for (let index = 0; index < segments; index++) {
      const next = (index + 1) % segments;
      triangle(front, rings[0][next], rings[0][index], material, group);
      triangle(rear, rings[rings.length - 1][index], rings[rings.length - 1][next], material, group);
    }
  }

  function ring(group: string, center: Vector, radius: number, tube: number, material: MaterialName = "hull", segments = 96, sides = 12) {
    const rings = Array.from({ length: segments }, (_, section) => {
      const angle = section / segments * TAU;
      return Array.from({ length: sides }, (_, side) => {
        const around = side / sides * TAU;
        const radial = radius + tube * Math.sin(around);
        return vertex([center[0] + tube * Math.cos(around), center[1] + radial * Math.cos(angle), center[2] + radial * Math.sin(angle)]);
      });
    });
    for (let section = 0; section < segments; section++) {
      for (let side = 0; side < sides; side++) {
        quad(rings[section][side], rings[section][(side + 1) % sides], rings[(section + 1) % segments][(side + 1) % sides], rings[(section + 1) % segments][side], material, group);
      }
    }
  }

  function solid(group: string, positions: Vector[], polygons: number[][], material: MaterialName) {
    const center: Vector = [0, 0, 0];
    for (const point of positions) for (let axis = 0; axis < 3; axis++) center[axis] += point[axis] / positions.length;
    for (const polygon of polygons) {
      const corners = polygon.map((index) => positions[index]);
      const normal = cross(subtract(corners[1], corners[0]), subtract(corners[2], corners[0]));
      const outward = subtract(corners[0], center);
      if (normal.reduce((total, value, axis) => total + value * outward[axis], 0) < 0) corners.reverse();
      const ids = corners.map(vertex);
      for (let index = 1; index < ids.length - 1; index++) triangle(ids[0], ids[index], ids[index + 1], material, group);
    }
  }

  function beam(group: string, start: Vector, end: Vector, width: number, depth: number, material: MaterialName = "structure") {
    const along = unit(subtract(end, start));
    const across = unit(cross(along, Math.abs(along[1]) > .9 ? [0, 0, 1] : [0, 1, 0]));
    const up = cross(along, across);
    const corners: Vector[] = [];
    for (const center of [start, end]) {
      for (const [side, vertical] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const corner: Vector = [...center];
        for (let axis = 0; axis < 3; axis++) corner[axis] += across[axis] * width / 2 * side + up[axis] * depth / 2 * vertical;
        corners.push(corner);
      }
    }
    solid(group, corners, [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], material);
  }

  loft("continuous_hull", [
    [-2.32, -.015, 0, .026, .024], [-2.1, -.03, 0, .12, .17],
    [-1.66, .005, 0, .22, .31], [-1.02, .045, 0, .25, .38],
    [-.25, .065, 0, .265, .39], [.45, .09, 0, .27, .35],
    [1.12, .13, 0, .235, .28], [1.72, .15, 0, .2, .24],
    [1.88, .15, 0, .125, .17],
  ]);
  loft("observation_gallery", [
    [-1.86, -.16, 0, .02, .08], [-1.56, -.26, 0, .095, .205],
    [-1.05, -.265, 0, .12, .25], [-.63, -.21, 0, .04, .21],
  ], "ceramic");
  loft("gallery_glazing", [
    [-1.57, -.272, 0, .033, .213], [-1.1, -.3, 0, .04, .259], [-.86, -.272, 0, .024, .233],
  ], "glass");

  const ringX = .04;
  ring("habitat_ring", [ringX, .03, 0], .81, .135, "ceramic");
  ring("habitat_inner_rim", [ringX - .085, .03, 0], .681, .025, "structure", 96, 8);
  ring("habitat_rear_rim", [ringX + .085, .03, 0], .918, .02, "structure", 96, 8);
  for (let index = 0; index < 3; index++) {
    const angle = index / 3 * TAU + Math.PI;
    beam("habitat_spokes", [ringX, .03 + Math.cos(angle) * .2, Math.sin(angle) * .2], [ringX, .03 + Math.cos(angle) * .81, Math.sin(angle) * .81], .085, .095);
  }
  for (const side of [-1, 1]) {
    for (let index = 0; index < 64; index++) {
      const angle = index / 64 * TAU;
      const corners: number[] = [];
      for (const [radius, offset] of [[.789, -.016], [.834, -.016], [.834, .016], [.789, .016]]) {
        corners.push(vertex([ringX + side * .136, .03 + Math.cos(angle + offset) * radius, Math.sin(angle + offset) * radius]));
      }
      if (side < 0) corners.reverse();
      quad(corners[0], corners[1], corners[2], corners[3], "windows", "habitat_windows");
    }
    const z = side * .67;
    beam("drive_mount", [.75, .13, side * .19], [1.25, .15, z], .13, .14);
    loft("drive_pod", [
      [.63, .15, z, .05, .05], [.9, .15, z, .16, .16],
      [1.26, .15, z, .185, .185], [2.08, .15, z, .185, .185],
      [2.33, .15, z, .21, .21], [2.46, .15, z, .21, .21],
    ], "hull", 24);
    ring("drive_collar", [1.81, .15, z], .189, .027, "structure", 40, 8);
    ring("drive_nozzle", [2.47, .15, z], .187, .032, "ceramic", 48, 10);
    ring("drive_light", [2.489, .15, z], .138, .024, "drive", 48, 8);
    loft("drive_core", [[2.47, .15, z, .112, .112], [2.485, .15, z, .112, .112]], "drive", 32);

    const panel: Vector[] = [[.5, .075, side * .3], [1.58, .18, side * .37], [1.31, -.02, side * 1.13], [.61, -.19, side * 1.02]];
    solid("folded_radiator", [...panel, ...panel.map(([x, y, z]): Vector => [x, y + .04, z])], [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], "radiator");
    for (let rib = 0; rib <= 6; rib++) {
      const amount = rib / 6;
      const a = panel[0].map((value, axis) => value + (panel[1][axis] - value) * amount);
      const b = panel[3].map((value, axis) => value + (panel[2][axis] - value) * amount);
      beam("radiator_ribs", [a[0], a[1] - .01, a[2]], [b[0], b[1] - .01, b[2]], .019, .024, "hull");
    }
    for (let index = 0; index < 13; index++) {
      const x = -1.58 + index * .061;
      beam("observation_windows", [x, -.273, side * .243], [x + .022, -.273, side * .243], .009, .032, "windows");
    }
    beam("bow_running_light", [-2.01, -.073, side * .159], [-1.71, -.13, side * .277], .012, .012, "windows");
    beam("lower_keel", [-1.58, .18, side * .14], [1.3, .32, side * .14], .055, .063, "structure");
  }
  beam("sensor_mast", [-.5, -.17, 0], [-.46, -.58, 0], .055, .065, "ceramic");
  beam("sensor_array", [-.46, -.58, -.24], [-.46, -.58, .24], .05, .04, "ceramic");
  beam("sensor_beacon", [-.46, -.61, -.1], [-.46, -.61, .1], .015, .015, "windows");

  const normals = vertices.map((): Vector => [0, 0, 0]);
  let totalArea = 0;
  const distribution = faces.map((face) => {
    const [a, b, c] = face.indices.map((index) => vertices[index]);
    const normal = cross(subtract(b, a), subtract(c, a));
    const area = Math.hypot(...normal) / 2;
    for (const index of face.indices) for (let axis = 0; axis < 3; axis++) normals[index][axis] += normal[axis];
    totalArea += area * (MATERIALS[face.material].emission ? 9 : 1);
    return totalArea;
  });
  for (let index = 0; index < normals.length; index++) normals[index] = unit(normals[index]);

  const rand = random(7112026);
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(.00001, rand()))) * Math.cos(TAU * rand());
  const scatter = () => {
    const angle = rand() * TAU;
    const distance = 2.4 + rand() * 3.3;
    return { sx: Math.cos(angle) * distance, sy: Math.sin(angle) * distance * .5, sz: gaussian() * 1.5, delay: rand() * .8, noise: rand() };
  };
  const points: ShipPoint[] = [];
  for (let sample = 0; sample < 16000; sample++) {
    const target = rand() * totalArea;
    let low = 0, high = distribution.length - 1;
    while (low < high) { const middle = (low + high) >>> 1; if (distribution[middle] < target) low = middle + 1; else high = middle; }
    const face = faces[low];
    const u = Math.sqrt(rand()), v = rand();
    const weights = [1 - u, u * (1 - v), u * v];
    const position: Vector = [0, 0, 0], interpolated: Vector = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      for (let corner = 0; corner < 3; corner++) {
        position[axis] += vertices[face.indices[corner]][axis] * weights[corner];
        interpolated[axis] += normals[face.indices[corner]][axis] * weights[corner];
      }
    }
    const normal = unit(interpolated);
    points.push({ x: position[0], y: position[1], z: position[2], nx: normal[0], ny: normal[1], nz: normal[2], exhaust: false, phase: 0, ...MATERIALS[face.material], ...scatter() });
  }
  for (const side of [-1, 1]) {
    for (let index = 0; index < 600; index++) {
      const length = rand();
      const width = .082 * (1 - length * .6);
      points.push({ x: 2.51 + length * .7, y: .15 + gaussian() * width, z: side * .67 + gaussian() * width, nx: 1, ny: 0, nz: 0, albedo: 1, emission: Math.pow(1 - length, 1.5), exhaust: true, phase: rand() * TAU, ...scatter() });
    }
  }

  const meshVertices = new Float32Array(vertices.length * 6);
  for (let index = 0; index < vertices.length; index++) {
    meshVertices.set(vertices[index], index * 6);
    meshVertices.set(normals[index], index * 6 + 3);
  }
  const mesh = { vertices: meshVertices, indices: new Uint32Array(faces.flatMap((face) => face.indices)), materials: faces.map((face) => MATERIALS[face.material]) };
  return { points, mesh, exhaust: points.filter((point) => point.exhaust) };
}
