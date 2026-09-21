import type { AsciiMaterial, AsciiMesh } from "../../components/ui/asciiMesh";

type Vector = [number, number, number];
type Tube = { offset: number; rings: number; radius: number; length: number; joints: readonly [number, number]; thumb: boolean };
type Finger = Tube & { base: Vector; splay: number; flex: number };
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
const bump = (value: number, center: number, width: number) => Math.exp(-(((value - center) / width) ** 2));

// Wrist, heel, thenar/hypothenar pads and the curved row of knuckles share a
// continuous palm surface. Coordinates face the camera, with +z on the palm.
const sections = [
  [4.4, 1.04, 0.66, 0.60, -0.08], [3.45, 1.10, 0.74, 0.68, -0.05],
  [2.7, 1.38, 0.92, 0.78, -0.08], [1.65, 1.76, 0.90, 0.92, -0.05],
  [0.5, 1.96, 0.70, 1.00, -0.015], [-0.45, 1.97, 0.57, 0.87, 0.025],
  [-1.2, 1.87, 0.48, 0.67, 0.02], [-1.68, 1.46, 0.30, 0.42, 0.02],
] as const;
const knuckleRow = [[-1.38, -1.34], [-0.46, -1.53], [0.49, -1.39], [1.36, -1.07]] as const;
const WRIST_BEND = -0.22;

// Keep the palm upright; the forearm meets it through a gently extended wrist.
function bendWrist([x, y, z]: Vector): Vector {
  const angle = WRIST_BEND * blend(2.7, 3.65, y);
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return [x, 2.7 + (y - 2.7) * cosine - z * sine, (y - 2.7) * sine + z * cosine];
}

function palmPoint(t: number, angle: number, grip: number): Vector {
  const y = 4.4 - t * 6.08;
  let index = 0;
  while (index < sections.length - 2 && y < sections[index + 1][0]) index++;
  const a = sections[index], b = sections[index + 1];
  const fraction = blend(0, 1, (a[0] - y) / (a[0] - b[0]));
  const width = (a[1] + (b[1] - a[1]) * fraction) * (1 - grip * 0.035);
  const facing = Math.sin(angle);
  const depth = facing >= 0 ? a[2] + (b[2] - a[2]) * fraction : a[3] + (b[3] - a[3]) * fraction;
  const centerZ = a[4] + (b[4] - a[4]) * fraction;
  const x = Math.cos(angle) * width;
  const thenar = 0.48 * Math.exp(-((x + 1.02) ** 2 / 0.65 + (y - 1.35) ** 2 / 1.55));
  const hypothenar = 0.29 * Math.exp(-((x - 1.2) ** 2 / 0.43 + (y - 1.3) ** 2 / 1.8));
  const hollow = 0.19 * Math.exp(-(x * x / 0.75 + (y - 0.5) ** 2 / 1.3));
  const knuckles = knuckleRow.reduce((height, [kx, ky]) =>
    height + bump(x, kx, 0.34) * bump(y, ky + 0.12, 0.42), 0);
  const tendons = knuckleRow.reduce((height, [kx]) => height + bump(x, kx * 0.8, 0.10), 0)
    * bump(y, 0.25, 1.15) * 0.055;
  const back = Math.max(0, -facing);
  const z = centerZ + Math.sign(facing) * Math.abs(facing) ** 0.96 * depth
    + (thenar + hypothenar - hollow + grip * 0.12 * (x / width) ** 2) * Math.max(0, facing) ** 3
    - ((0.22 + grip * 0.20) * knuckles + tendons) * back ** 3;
  const crown = blend(0.7, 1, t) * (0.22 * (x / width) ** 2 + 0.10 * x / width);
  return bendWrist([x, y + crown - (0.08 + grip * 0.16) * knuckles * back ** 2, z]);
}

function radiusAt(t: number, part: Tube): number {
  const [first, second] = part.joints;
  const joints = 0.14 * bump(t, first, 0.052) + 0.10 * bump(t, second, 0.042);
  const taper = part.thumb ? 1.35 - 0.60 * t : 1 - 0.21 * t + 0.07 * bump(t, 0.04, 0.10);
  const pad = 0.045 * bump(t, 0.60, 0.10) + 0.07 * bump(t, 0.89, 0.07);
  const tip = Math.max(0, (t - 0.90) / 0.10);
  return part.radius * (taper + joints + pad) * Math.sqrt(Math.max(0.0001, 1 - tip * tip));
}

/** Straight phalanges, with a short soft transition around each joint. */
function bonePath(joints: Vector[], stops: readonly number[]): (t: number) => Vector {
  const straight = (t: number): Vector => {
    const clamped = Math.max(0, Math.min(1, t));
    let index = 0;
    while (index < stops.length - 2 && clamped > stops[index + 1]) index++;
    return mix(joints[index], joints[index + 1], (clamped - stops[index]) / (stops[index + 1] - stops[index]));
  };
  return (t) => {
    for (let index = 1; index < stops.length - 1; index++) {
      const joint = stops[index], rounding = 0.045;
      if (t < joint - rounding || t > joint + rounding) continue;
      const f = (t - joint + rounding) / (2 * rounding);
      const before = straight(joint - rounding), after = straight(joint + rounding);
      return before.map((value, axis) => (1 - f) ** 2 * value + 2 * (1 - f) * f * joints[index][axis] + f * f * after[axis]) as Vector;
    }
    return straight(t);
  };
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
  const palmVertex = (t: number, angle: number, grip: number): number[] => {
    const point = palmPoint(t, angle, grip);
    const before = palmPoint(t - 0.001, angle, grip), after = palmPoint(t + 0.001, angle, grip);
    const left = palmPoint(t, angle - 0.001, grip), right = palmPoint(t, angle + 0.001, grip);
    const along = after.map((value, axis) => value - before[axis]);
    const around = right.map((value, axis) => value - left[axis]);
    let normal = unit([
      along[1] * around[2] - along[2] * around[1],
      along[2] * around[0] - along[0] * around[2],
      along[0] * around[1] - along[1] * around[0],
    ]);
    if (normal[0] * point[0] + normal[2] * point[2] < 0) normal = normal.map((value) => -value) as Vector;
    return [...point, ...normal];
  };
  const closed: number[] = [];
  for (let ring = 0; ring <= palmRings; ring++) {
    for (let side = 0; side < palmSides; side++) {
      const t = ring / palmRings, angle = side / palmSides * Math.PI * 2;
      vertices.push(...palmVertex(t, angle, 0));
      closed.push(...palmVertex(t, angle, 1));
    }
  }
  connect(0, palmRings, palmSides, () => SKIN);
  for (const ring of [0, palmRings]) {
    const center = vertices.length / 6;
    const cap = ring === 0
      ? [...bendWrist([0, 4.4, sections[0][4]]), 0, Math.cos(WRIST_BEND), Math.sin(WRIST_BEND)]
      : [0, -1.68, sections[sections.length - 1][4], 0, -1, 0];
    vertices.push(...cap);
    closed.push(...cap);
    for (let side = 0; side < palmSides; side++) {
      indices.push(center, ring * palmSides + side, ring * palmSides + (side + 1) % palmSides);
      materials.push(SKIN);
    }
  }
  const palm = new Float32Array(vertices), closedPalm = new Float32Array(closed);

  const tube = (length: number, radius: number, rings: number, thumb = false): Tube => {
    const offset = vertices.length / 6;
    const joints: readonly [number, number] = thumb ? [1.5 / 3.72, 2.72 / 3.72] : [0.46, 0.76];
    for (let index = 0; index < (rings + 1) * SIDES * 6; index++) vertices.push(0);
    connect(offset, rings, SIDES, (ring, side) => {
      const t = (ring + 0.5) / rings, angle = (side + 0.5) / SIDES * Math.PI * 2;
      if (t > 0.81 && t < 0.96 && Math.sin(angle) < -0.75) return NAIL;
      if (joints.some((joint) => Math.abs(t - joint) < 0.024) && Math.sin(angle) > 0.5) return CREASE;
      return SKIN;
    });
    return { offset, rings, radius, length, joints, thumb };
  };
  const fingers: Finger[] = [
    { ...tube(3.55, 0.43, 22), base: [-1.38, -1.34, 0.12], splay: -0.14, flex: 0 },
    { ...tube(3.95, 0.45, 22), base: [-0.46, -1.53, 0.06], splay: -0.035, flex: 0.02 },
    { ...tube(3.68, 0.43, 22), base: [0.49, -1.39, 0.10], splay: 0.065, flex: 0.065 },
    { ...tube(2.83, 0.34, 20), base: [1.36, -1.07, 0.20], splay: 0.20, flex: 0.10 },
  ];
  const thumb = tube(3.72, 0.51, 24, true);
  const mesh: AsciiMesh = { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), materials };

  const ring = (part: Tube, index: number, center: Vector, tangent: Vector, side: Vector) => {
    const front: Vector = [tangent[1] * side[2] - tangent[2] * side[1], tangent[2] * side[0] - tangent[0] * side[2], tangent[0] * side[1] - tangent[1] * side[0]];
    const t = index / part.rings, radius = radiusAt(t, part);
    const joint = Math.max(bump(t, part.joints[0], 0.052), bump(t, part.joints[1], 0.042));
    const slope = (radiusAt(Math.min(1, t + 0.001), part) - radiusAt(Math.max(0, t - 0.001), part)) / (0.002 * part.length);
    for (let step = 0; step < SIDES; step++) {
      const angle = step / SIDES * Math.PI * 2, cosine = Math.cos(angle), sine = Math.sin(angle);
      const roundness = sine > 0 ? 0.94 + 0.12 * bump(t, 0.88, 0.12) : 0.80 + 0.18 * joint;
      const exponent = 0.86;
      const crossX = Math.sign(cosine) * Math.abs(cosine) ** exponent;
      const crossZ = Math.sign(sine) * Math.abs(sine) ** exponent;
      const normalX = Math.sign(cosine) * Math.abs(cosine) ** (2 - exponent);
      const normalZ = Math.sign(sine) * Math.abs(sine) ** (2 - exponent) / roundness;
      const normal = unit(side.map((value, axis) => value * normalX + front[axis] * normalZ - tangent[axis] * slope) as Vector);
      const offset = (part.offset + index * SIDES + step) * 6;
      for (let axis = 0; axis < 3; axis++) {
        mesh.vertices[offset + axis] = center[axis] + radius * (side[axis] * crossX + front[axis] * crossZ * roundness);
        mesh.vertices[offset + 3 + axis] = normal[axis];
      }
    }
  };
  const digit = (part: Tube, points: Vector[], stops: readonly number[], splay?: number, roll = 0) => {
    const pointAt = bonePath(points, stops);
    for (let index = 0; index <= part.rings; index++) {
      const t = index / part.rings, before = pointAt(t - 0.001), after = pointAt(t + 0.001);
      const tangent = unit(after.map((value, axis) => value - before[axis]) as Vector);
      let side: Vector = splay === undefined ? unit([-tangent[1], tangent[0], 0]) : [Math.cos(splay), Math.sin(splay), 0];
      if (roll) {
        const front: Vector = [tangent[1] * side[2] - tangent[2] * side[1], tangent[2] * side[0] - tangent[0] * side[2], tangent[0] * side[1] - tangent[1] * side[0]];
        side = side.map((value, axis) => value * Math.cos(roll) + front[axis] * Math.sin(roll)) as Vector;
      }
      ring(part, index, pointAt(t), tangent, side);
    }
  };

  return { mesh, pose(mask, extension, mirror) {
    let grip = 0;
    for (let finger = 0; finger < fingers.length; finger++) grip += (1 - (mask & (1 << (finger + 1)) ? extension : 0)) / 4;
    // Both palm surfaces and their normals are prepared once; cupping adds no tessellation per frame.
    for (let index = 0; index < palm.length; index += 6) {
      for (let axis = 0; axis < 6; axis++) mesh.vertices[index + axis] = palm[index + axis] + (closedPalm[index + axis] - palm[index + axis]) * grip;
      const normal = unit([mesh.vertices[index + 3], mesh.vertices[index + 4], mesh.vertices[index + 5]]);
      mesh.vertices.set(normal, index + 3);
    }
    for (let finger = 0; finger < fingers.length; finger++) {
      const part = fingers[finger];
      const open = mask & (1 << (finger + 1)) ? extension : 0;
      const curl = 1 - open, splay = part.splay * open;
      const stops = [0, ...part.joints, 1];
      // The closed tip folds back to the palm instead of stopping in a hovering hook.
      const angles = [
        0.025 + part.flex * 0.35 + curl * (1.425 + part.flex * 0.65),
        0.035 + curl * (1.665 - part.flex * 0.4),
        0.025 + curl * 1.025,
      ];
      let angle = 0;
      const points: Vector[] = [[part.base[0] * (1 - curl * 0.025), part.base[1], part.base[2]]];
      for (let joint = 0; joint < 3; joint++) {
        angle += angles[joint];
        const direction: Vector = [Math.sin(splay) * Math.cos(angle), -Math.cos(splay) * Math.cos(angle), Math.sin(angle)];
        const length = part.length * (stops[joint + 1] - stops[joint]);
        points.push(points[joint].map((value, axis) => value + direction[axis] * length) as Vector);
      }
      digit(part, points, stops, splay);
    }

    // Thumb opposition rotates across the palm, independently of the four
    // finger hinges. Keep bone lengths fixed while its direction changes.
    const open = mask & 1 ? extension : 0;
    const points: Vector[] = [[-1.20, 1.80 - 0.20 * grip, 0.40]];
    const folded: Vector[] = [[-0.48, -0.82, 0.10 + grip * 0.45], [0.80, -0.25, 0.10 + grip * 0.45], [0.94, 0.10, 0.06 + grip * 0.12]];
    const spread: Vector[] = [[-0.82, -0.57, 0.05], [-0.70, -0.71, 0.10], [-0.61, -0.79, -0.03]];
    const lengths = [1.50, 1.22, 1.00];
    for (let joint = 0; joint < 3; joint++) {
      const extended = unit(spread[joint]);
      const direction = unit(mix(unit(folded[joint]), extended, open));
      points.push(points[joint].map((value, axis) => value + direction[axis] * lengths[joint]) as Vector);
    }
    digit(thumb, points, [0, ...thumb.joints, 1], undefined, -0.48 + open * 0.18);
    if (mirror) {
      for (let index = 0; index < mesh.vertices.length; index += 6) {
        mesh.vertices[index] *= -1;
        mesh.vertices[index + 3] *= -1;
      }
    }
  } };
}
