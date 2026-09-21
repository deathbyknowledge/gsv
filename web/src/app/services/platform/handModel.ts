import type { AsciiMaterial, AsciiMesh } from "../../components/ui/asciiMesh";

type Vector = [number, number, number];
type Tube = { offset: number; rings: number; radius: number; length: number };
type Finger = Tube & { base: Vector; splay: number };
export type HandModel = { mesh: AsciiMesh; pose: (mask: number, extension: number, mirror: boolean) => void };

const SIDES = 12;
const SKIN: AsciiMaterial = { albedo: 0.98, emission: 0 };
const NAIL: AsciiMaterial = { albedo: 1.08, emission: 0 };
const CREASE: AsciiMaterial = { albedo: 0.72, emission: 0 };
const unit = ([x, y, z]: Vector): Vector => {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
};
const blend = (start: number, end: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
};
const mix = (a: Vector, b: Vector, t: number): Vector => a.map((value, axis) => value + (b[axis] - value) * t) as Vector;

// Wrist, heel, thenar/hypothenar pads and the curved row of knuckles share a
// continuous palm surface. Coordinates face the camera, with +z on the palm.
const sections = [
  [4.4, 1.09, 0.68, 0.60, -0.06], [3.4, 1.13, 0.71, 0.62, -0.06],
  [2.6, 1.48, 0.83, 0.67, -0.10], [1.4, 1.80, 0.76, 0.56, -0.05],
  [0.1, 1.94, 0.62, 0.50, 0.02], [-1.0, 1.89, 0.56, 0.53, 0.06],
  [-1.45, 1.42, 0.39, 0.41, 0.03],
] as const;

function palmPoint(t: number, angle: number): Vector {
  const y = 4.4 - t * 5.85;
  let index = 0;
  while (index < sections.length - 2 && y < sections[index + 1][0]) index++;
  const a = sections[index], b = sections[index + 1];
  const fraction = Math.max(0, Math.min(1, (a[0] - y) / (a[0] - b[0])));
  const width = a[1] + (b[1] - a[1]) * fraction;
  const facing = Math.sin(angle);
  const depth = facing >= 0 ? a[2] + (b[2] - a[2]) * fraction : a[3] + (b[3] - a[3]) * fraction;
  const centerZ = a[4] + (b[4] - a[4]) * fraction;
  const x = Math.cos(angle) * width;
  const thenar = 0.42 * Math.exp(-((x + 1.05) ** 2 / 0.72 + (y - 1.45) ** 2 / 1.7));
  const hypothenar = 0.24 * Math.exp(-((x - 1.15) ** 2 / 0.50 + (y - 1.4) ** 2 / 2));
  const hollow = 0.16 * Math.exp(-(x * x / 0.70 + (y - 0.45) ** 2 / 1.2));
  const knuckles = [-1.38, -0.46, 0.49, 1.36].reduce((height, knuckle) =>
    height + 0.12 * Math.exp(-((x - knuckle) ** 2 / 0.12 + (y + 0.85) ** 2 / 0.38)), 0);
  const z = centerZ + Math.sign(facing) * Math.abs(facing) ** 0.92 * depth
    + (thenar + hypothenar - hollow) * Math.max(0, facing) ** 3
    - knuckles * Math.max(0, -facing) ** 3;
  return [x, y + blend(0.7, 1, t) * (0.22 * (x / width) ** 2 + 0.10 * x / width), z];
}

function radiusAt(t: number, radius: number): number {
  const knuckles = 1 + 0.045 * Math.exp(-(((t - 0.44) / 0.07) ** 2)) + 0.025 * Math.exp(-(((t - 0.74) / 0.06) ** 2));
  const tip = Math.max(0, (t - 0.87) / 0.13);
  return radius * (1 - 0.24 * t) * knuckles * Math.sqrt(Math.max(0.0001, 1 - tip * tip));
}

/** Original articulated hand geometry; all poses deform one reusable mesh. */
export function createHandModel(): HandModel {
  const vertices: number[] = [], indices: number[] = [], materials: AsciiMaterial[] = [];
  const connect = (offset: number, rings: number, sides: number, material: (ring: number, side: number) => AsciiMaterial) => {
    for (let ring = 0; ring < rings; ring++) {
      for (let side = 0; side < sides; side++) {
        const a = offset + ring * sides + side, b = offset + ring * sides + (side + 1) % sides;
        indices.push(a, b, a + sides, b, b + sides, a + sides);
        materials.push(material(ring, side), material(ring, side));
      }
    }
  };

  const palmRings = 20, palmSides = 24;
  for (let ring = 0; ring <= palmRings; ring++) {
    for (let side = 0; side < palmSides; side++) {
      const t = ring / palmRings, angle = side / palmSides * Math.PI * 2;
      const point = palmPoint(t, angle);
      const before = palmPoint(t - 0.001, angle), after = palmPoint(t + 0.001, angle);
      const left = palmPoint(t, angle - 0.001), right = palmPoint(t, angle + 0.001);
      const along = after.map((value, axis) => value - before[axis]);
      const around = right.map((value, axis) => value - left[axis]);
      let normal = unit([
        along[1] * around[2] - along[2] * around[1],
        along[2] * around[0] - along[0] * around[2],
        along[0] * around[1] - along[1] * around[0],
      ]);
      if (normal[0] * point[0] + normal[2] * point[2] < 0) normal = normal.map((value) => -value) as Vector;
      vertices.push(...point, ...normal);
    }
  }
  connect(0, palmRings, palmSides, () => SKIN);
  for (const ring of [0, palmRings]) {
    const center = vertices.length / 6;
    vertices.push(0, ring === 0 ? 4.4 : -1.45, ring === 0 ? sections[0][4] : sections[sections.length - 1][4], 0, ring === 0 ? 1 : -1, 0);
    for (let side = 0; side < palmSides; side++) {
      indices.push(center, ring * palmSides + side, ring * palmSides + (side + 1) % palmSides);
      materials.push(SKIN);
    }
  }
  const palm = new Float32Array(vertices);

  const tube = (length: number, radius: number, rings: number): Tube => {
    const offset = vertices.length / 6;
    for (let index = 0; index < (rings + 1) * SIDES * 6; index++) vertices.push(0);
    connect(offset, rings, SIDES, (ring, side) => {
      const t = (ring + 0.5) / rings, angle = (side + 0.5) / SIDES * Math.PI * 2;
      if (t > 0.81 && t < 0.96 && Math.sin(angle) < -0.75) return NAIL;
      if ((Math.abs(t - 0.44) < 0.024 || Math.abs(t - 0.74) < 0.02) && Math.sin(angle) > 0.5) return CREASE;
      return SKIN;
    });
    return { offset, rings, radius, length };
  };
  const fingers: Finger[] = [
    { ...tube(3.55, 0.43, 22), base: [-1.38, -1.16, 0.18], splay: -0.14 },
    { ...tube(3.95, 0.45, 22), base: [-0.46, -1.43, 0.10], splay: -0.035 },
    { ...tube(3.68, 0.43, 22), base: [0.49, -1.30, 0.03], splay: 0.065 },
    { ...tube(2.83, 0.34, 20), base: [1.36, -0.94, -0.10], splay: 0.20 },
  ];
  const thumb = tube(3.50, 0.51, 24);
  const mesh: AsciiMesh = { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), materials };

  const ring = (part: Tube, index: number, center: Vector, tangent: Vector, side: Vector) => {
    const front: Vector = [tangent[1] * side[2] - tangent[2] * side[1], tangent[2] * side[0] - tangent[0] * side[2], tangent[0] * side[1] - tangent[1] * side[0]];
    const t = index / part.rings, radius = radiusAt(t, part.radius);
    const roundness = 0.96;
    const slope = (radiusAt(Math.min(1, t + 0.001), part.radius) - radiusAt(Math.max(0, t - 0.001), part.radius)) / (0.002 * part.length);
    for (let step = 0; step < SIDES; step++) {
      const angle = step / SIDES * Math.PI * 2, cosine = Math.cos(angle), sine = Math.sin(angle);
      const normal = unit(side.map((value, axis) => value * cosine + front[axis] * sine / roundness - tangent[axis] * slope) as Vector);
      const offset = (part.offset + index * SIDES + step) * 6;
      for (let axis = 0; axis < 3; axis++) {
        mesh.vertices[offset + axis] = center[axis] + radius * (side[axis] * cosine + front[axis] * sine * roundness);
        mesh.vertices[offset + 3 + axis] = normal[axis];
      }
    }
  };

  return { mesh, pose(mask, extension, mirror) {
    mesh.vertices.set(palm);
    let grip = 0;
    for (let finger = 0; finger < fingers.length; finger++) {
      const part = fingers[finger];
      const open = mask & (1 << (finger + 1)) ? extension : 0;
      grip += (1 - open) / 4;
      const splay = part.splay * open;
      const side: Vector = [Math.cos(splay), Math.sin(splay), 0];
      const direction = (t: number): Vector => {
        const curl = 1 - open;
        const angle = 0.035 + curl * 0.97 + blend(0.35, 0.55, t) * (0.025 + curl * 1.27) + blend(0.66, 0.85, t) * (0.03 + curl * 0.62);
        return [Math.sin(splay) * Math.cos(angle), -Math.cos(splay) * Math.cos(angle), Math.sin(angle)];
      };
      const center: Vector = [...part.base];
      for (let index = 0; index <= part.rings; index++) {
        if (index > 0) {
          const step = direction((index - 0.5) / part.rings);
          for (let axis = 0; axis < 3; axis++) center[axis] += step[axis] * part.length / part.rings;
        }
        ring(part, index, center, direction(index / part.rings), side);
      }
    }

    // Thumb opposition rotates across the palm, independently of the four
    // finger hinges. Keep bone lengths fixed while its direction changes.
    const open = mask & 1 ? extension : 0;
    const joints: Vector[] = [[-1.22, 1.80, 0.34]];
    const folded: Vector[] = [[-0.45, -0.84, 0.35 + grip * 0.35], [0.82, -0.34, 0.25 + grip * 0.50], [0.95, 0.10, 0.08 + grip * 0.13]];
    const lengths = [1.45, 1.15, 0.90];
    for (let joint = 0; joint < 3; joint++) {
      const direction = unit(mix(unit(folded[joint]), unit([-0.64, -0.77, -0.025]), open));
      joints.push(joints[joint].map((value, axis) => value + direction[axis] * lengths[joint]) as Vector);
    }
    const pointAt = (t: number): Vector => {
      const position = Math.max(0, Math.min(1, t)) * 3, index = Math.min(2, Math.floor(position)), f = position - index;
      const a = joints[Math.max(0, index - 1)], b = joints[index], c = joints[index + 1], d = joints[Math.min(3, index + 2)];
      return b.map((value, axis) => 0.5 * (2 * value + (-a[axis] + c[axis]) * f + (2 * a[axis] - 5 * value + 4 * c[axis] - d[axis]) * f * f + (-a[axis] + 3 * value - 3 * c[axis] + d[axis]) * f * f * f)) as Vector;
    };
    for (let index = 0; index <= thumb.rings; index++) {
      const t = index / thumb.rings, before = pointAt(t - 0.001), after = pointAt(t + 0.001);
      const tangent = unit(after.map((value, axis) => value - before[axis]) as Vector);
      const side = unit([-tangent[1], tangent[0], 0]);
      ring(thumb, index, pointAt(t), tangent, side);
    }
    if (mirror) {
      for (let index = 0; index < mesh.vertices.length; index += 6) {
        mesh.vertices[index] *= -1;
        mesh.vertices[index + 3] *= -1;
      }
    }
  } };
}
