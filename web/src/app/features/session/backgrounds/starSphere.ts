export const STAR_HEIGHT = 8;
export const STAR_WIDTH = 5;

// A fixed angular scale lets a larger window reveal more sky, without zooming
// or moving the stars relative to its centre. Projection is independent of size.
const FOCAL_LENGTH = 2000;

export type SkyStar = {
  id: number;
  x: number;
  y: number;
  z: number;
  phase: number;
  rate: number;
  bright: boolean;
  base: number;
};

export type ProjectedStar = {
  star: SkyStar;
  x: number;
  y: number;
};

export function createStarSphere(density: number): SkyStar[] {
  let state = 137;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  // Match the existing cell density at the centre of the view. Uniform solid
  // angle sampling avoids clusters at the poles of the sphere.
  const count = Math.round(4 * Math.PI * FOCAL_LENGTH ** 2 * density / (STAR_WIDTH * STAR_HEIGHT));
  return Array.from({ length: count }, (_, id) => {
    const z = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(1 - z * z);
    return {
      id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      z,
      phase: random() * Math.PI * 2,
      rate: 0.7 + random() * 2.4,
      bright: random() > 0.82,
      base: 0.2 + random() * 0.45,
    };
  });
}

export function projectStarSphere(sphere: readonly SkyStar[]): ProjectedStar[] {
  const projected: ProjectedStar[] = [];
  const occupied = new Set<string>();
  for (const star of sphere) {
    if (star.z <= 0) continue;
    // Keep the existing glyph grid, snapping once in sky coordinates rather
    // than snapping again as the viewport moves across it.
    const x = Math.round(star.x / star.z * FOCAL_LENGTH / STAR_WIDTH) * STAR_WIDTH;
    const y = Math.round(star.y / star.z * FOCAL_LENGTH / STAR_HEIGHT) * STAR_HEIGHT;
    const cell = `${x},${y}`;
    if (occupied.has(cell)) continue;
    occupied.add(cell);
    projected.push({ star, x, y });
  }
  return projected.sort((a, b) => a.x - b.x);
}

export function visibleStars(projected: readonly ProjectedStar[], width: number, height: number): ProjectedStar[] {
  if (width <= 0 || height <= 0) return [];
  const left = -Math.floor(width / 2) - STAR_WIDTH;
  const top = -Math.floor(height / 2) - STAR_HEIGHT;
  const right = width - Math.floor(width / 2);
  const bottom = height - Math.floor(height / 2);
  let low = 0;
  let high = projected.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (projected[mid].x <= left) low = mid + 1;
    else high = mid;
  }
  const visible: ProjectedStar[] = [];
  for (let i = low; i < projected.length && projected[i].x < right; i += 1) {
    const star = projected[i];
    if (star.y > top && star.y < bottom) visible.push(star);
  }
  return visible;
}
