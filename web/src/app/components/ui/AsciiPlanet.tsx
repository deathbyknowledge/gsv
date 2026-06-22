import type { JSX } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";

export type AsciiPlanetVariant =
  | "orbit"
  | "giant"
  | "moon"
  | "disc"
  | "terminator"
  | "crescent"
  | "orb";

export type AsciiPlanetProps = {
  variant?: AsciiPlanetVariant;
  animate?: boolean;
  showStars?: boolean;
  size?: number;
  formDuration?: number;
  label?: string;
};

type LightVector = [number, number, number];
type RingRange = [number, number];

type PlanetConfig = {
  v: AsciiPlanetVariant;
  PW: number;
  PH: number;
  FS: number;
  Rx: number;
  light: LightVector;
  bands?: number;
  craters?: number;
  cut: number;
  gamma: number;
  contrast: number;
  pivot: number;
  spec?: number;
  specP?: number;
  ring?: RingRange;
  ringEl?: number;
  seed: number;
};

type PlanetCell = {
  x: number;
  y: number;
  ch: string;
};

type PlanetRender = {
  rows: string[];
  cells: PlanetCell[];
};

type Particle = {
  tx: number;
  ty: number;
  ch: string;
  sx: number;
  sy: number;
  delay: number;
  phase: number;
  flRate: number;
  amp: number;
};

type Star = {
  idx: number;
  g: string;
};

type RuntimePlanet = {
  rows: string[];
  parts: Particle[];
  stars: Star[];
  starBaseRows: string[];
  starBase: string;
  twIdx: number;
  twStart: number;
  starDrawn: boolean;
  nextTwinkle: number;
  startDelay: number;
  formedDrawn: boolean;
  nextGlitch: number;
  glitchUntil: number;
};

const RAMP = " .-:=+*oO#@";
const GLYPH_COLOR = "#8071dd";
const GLYPH_GLOW = "0 0 5px rgba(140,120,235,.40), 0 0 13px rgba(110,95,209,.20)";

const PRESETS: Record<AsciiPlanetVariant, Omit<PlanetConfig, "v">> = {
  orbit: { PW: 90, PH: 44, FS: 8, Rx: 17, light: [-0.64, -0.42, 0.5], bands: 8, craters: 3, cut: 0.05, gamma: 1.55, contrast: 1.9, pivot: 0.32, spec: 0.95, specP: 9, ring: [1.5, 2.12], ringEl: 0.31, seed: 60 },
  moon: { PW: 90, PH: 44, FS: 8, Rx: 20, light: [-0.62, -0.34, 0.56], craters: 17, cut: 0.06, gamma: 1.45, contrast: 1.78, pivot: 0.33, spec: 0.42, specP: 16, seed: 73 },
  giant: { PW: 90, PH: 44, FS: 8, Rx: 18, light: [-0.18, -0.58, 0.79], bands: 11, craters: 1, cut: 0.05, gamma: 1.4, contrast: 1.6, pivot: 0.34, spec: 0.55, specP: 11, ring: [1.12, 2.12], ringEl: 0.15, seed: 88 },
  disc: { PW: 66, PH: 36, FS: 6, Rx: 18, light: [-0.34, -0.4, 0.86], craters: 10, cut: 0.08, gamma: 1.35, contrast: 1.35, pivot: 0.4, seed: 21 },
  terminator: { PW: 66, PH: 36, FS: 6, Rx: 18, light: [-0.66, -0.26, 0.62], craters: 7, cut: 0.1, gamma: 1.3, contrast: 1.3, pivot: 0.4, seed: 34 },
  crescent: { PW: 66, PH: 36, FS: 6, Rx: 18, light: [-0.9, -0.07, -0.34], craters: 4, cut: 0.1, gamma: 1.3, contrast: 1.3, pivot: 0.4, seed: 48 },
  orb: { PW: 24, PH: 14, FS: 4, Rx: 9, light: [-0.4, -0.4, 0.86], craters: 4, cut: 0.08, gamma: 1.4, contrast: 1.4, pivot: 0.4, seed: 12 },
};

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function easeOut(value: number): number {
  const x = clamp(value, 0, 1);
  return 1 - (1 - x) * (1 - x);
}

function configForVariant(variant: AsciiPlanetVariant): PlanetConfig {
  return {
    v: variant,
    ...PRESETS[variant],
  };
}

function addRing(
  grid: string[][],
  depth: number[][],
  config: PlanetConfig,
  cx: number,
  cy: number,
  rx: number,
): void {
  if (!config.ring) {
    return;
  }

  const random = makeRandom(config.seed * 3 + 1);
  const ringEl = config.ringEl ?? 0;
  const sinEl = Math.sin(ringEl);
  const cosEl = Math.cos(ringEl);
  const r0 = config.ring[0] * rx;
  const r1 = config.ring[1] * rx;
  const ringDepth = Array.from({ length: config.PW * config.PH }, () => -9);

  for (let i = 0; i < 900; i += 1) {
    const theta = (i / 900) * Math.PI * 2;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    for (let radius = r0; radius <= r1; radius += 0.5) {
      const col = cx + radius * cosTheta;
      const row = cy + radius * sinTheta * sinEl * 0.6;
      const z = radius * sinTheta * cosEl;
      const x = Math.round(col);
      const y = Math.round(row);

      if (x < 0 || x >= config.PW || y < 0 || y >= config.PH) {
        continue;
      }

      const planetZ = depth[y][x] > -9 ? depth[y][x] * rx : -1e9;
      if (z <= planetZ) {
        continue;
      }

      const index = y * config.PW + x;
      if (z <= ringDepth[index]) {
        continue;
      }

      const normalizedRadius = (radius - r0) / (r1 - r0);
      let density = 0.5 + 0.22 * Math.sin(normalizedRadius * 9);
      if (normalizedRadius > 0.4 && normalizedRadius < 0.49) {
        density *= 0.25;
      }
      if (z < 0) {
        density *= 0.72;
      }
      density *= 0.82 + 0.3 * random();
      if (density < 0.12) {
        continue;
      }

      const rampIndex = clamp(Math.floor(density * RAMP.length), 1, RAMP.length - 1);
      grid[y][x] = RAMP[rampIndex];
      ringDepth[index] = z;
    }
  }
}

function generatePlanet(config: PlanetConfig): PlanetRender {
  const cx = (config.PW - 1) / 2;
  const cy = (config.PH - 1) / 2;
  const rx = config.Rx;
  const ry = rx * 0.58;
  const [lightX, lightY, lightZ] = config.light;
  const lightLength = Math.hypot(lightX, lightY, lightZ) || 1;
  const lx = lightX / lightLength;
  const ly = lightY / lightLength;
  const lz = lightZ / lightLength;
  const random = makeRandom(config.seed);
  const craters: { n: LightVector; r: number }[] = [];

  for (let i = 0; i < (config.craters ?? 0); i += 1) {
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const side = Math.sqrt(1 - u * u);
    craters.push({
      n: [side * Math.cos(theta), side * Math.sin(theta), u],
      r: 0.13 + random() * 0.17,
    });
  }

  const grid = Array.from({ length: config.PH }, () => new Array<string>(config.PW).fill(" "));
  const depth = Array.from({ length: config.PH }, () => new Array<number>(config.PW).fill(-9));

  for (let y = 0; y < config.PH; y += 1) {
    for (let x = 0; x < config.PW; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) {
        continue;
      }

      const nz = Math.sqrt(1 - r2);
      const ndl = nx * lx + ny * ly + nz * lz;
      let brightness = Math.max(0, ndl);

      if (config.spec) {
        const rz = 2 * ndl * nz - lz;
        brightness += config.spec * Math.pow(Math.max(0, rz), config.specP ?? 12);
      }

      let detail = 1;
      if (config.bands) {
        detail *= 0.74
          + 0.26 * Math.sin(ny * config.bands * Math.PI + 0.6)
          + 0.1 * Math.sin(ny * config.bands * 2.7 * Math.PI + 1.1);
      }

      for (const crater of craters) {
        const distance = nx * crater.n[0] + ny * crater.n[1] + nz * crater.n[2];
        const angle = Math.acos(clamp(distance, -1, 1));
        if (angle < crater.r) {
          const t = angle / crater.r;
          detail *= t > 0.72 ? 1.28 : 0.5 + 0.5 * t;
        }
      }

      detail *= 0.9 + 0.2 * random();
      brightness *= detail;
      brightness *= 0.58 + 0.42 * nz;
      brightness = Math.pow(brightness, config.gamma);
      brightness = config.pivot + (brightness - config.pivot) * config.contrast;

      if (brightness < config.cut) {
        continue;
      }

      const rampIndex = clamp(Math.floor(Math.max(0, brightness) * RAMP.length), 1, RAMP.length - 1);
      grid[y][x] = RAMP[rampIndex];
      depth[y][x] = nz;
    }
  }

  addRing(grid, depth, config, cx, cy, rx);

  const cells: PlanetCell[] = [];
  for (let y = 0; y < config.PH; y += 1) {
    for (let x = 0; x < config.PW; x += 1) {
      if (grid[y][x] !== " ") {
        cells.push({ x, y, ch: grid[y][x] });
      }
    }
  }

  return {
    rows: grid.map((row) => row.join("")),
    cells,
  };
}

function buildParticles(cells: readonly PlanetCell[], seed: number, width: number): Particle[] {
  const random = makeRandom(seed * 13 + 5);
  return cells.map((cell) => {
    const sx = cell.x + 40 + random() * 78;
    const sy = cell.y + (random() - 0.5) * 60 - 6;
    const sweep = (1 - cell.x / width) * 0.26;
    return {
      tx: cell.x,
      ty: cell.y,
      ch: cell.ch,
      sx,
      sy,
      delay: clamp(sweep + random() * 0.16, 0, 0.44),
      phase: random() * Math.PI * 2,
      flRate: 3.2 + random() * 4.6,
      amp: 2.2 + random() * 4.2,
    };
  });
}

function buildStars(seed: number, width: number, height: number): Star[] {
  const random = makeRandom(seed);
  const stars: Star[] = [];
  for (let i = 0; i < width * height; i += 1) {
    if (random() > 0.972) {
      const roll = random();
      stars.push({ idx: i, g: roll > 0.9 ? "+" : roll > 0.55 ? "." : "." });
    }
  }
  return stars;
}

function buildStarRows(stars: readonly Star[], width: number, height: number): string[] {
  const buffer = new Array<string>(width * height).fill(" ");
  for (const star of stars) {
    buffer[star.idx] = star.g;
  }
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(buffer.slice(y * width, (y + 1) * width).join(""));
  }
  return rows;
}

function buildFormationFrame(runtime: RuntimePlanet, elapsed: number, config: PlanetConfig, formDuration: number): string {
  const buffer = new Array<string>(config.PW * config.PH).fill(" ");
  const progress = clamp(elapsed / formDuration, 0, 1);

  for (const particle of runtime.parts) {
    const local = clamp((progress - particle.delay) / (1 - particle.delay), 0, 1);
    if (local <= 0.02) {
      continue;
    }

    const eased = easeOut(local);
    const dx = particle.tx - particle.sx;
    const dy = particle.ty - particle.sy;
    const length = Math.hypot(dx, dy) || 1;
    const px = -dy / length;
    const py = dx / length;
    const flutter = (1 - eased) * particle.amp * Math.sin(elapsed * particle.flRate + particle.phase);
    const x = particle.sx + dx * eased + px * flutter;
    const y = particle.sy + dy * eased + py * flutter;
    const xi = Math.round(x);
    const yi = Math.round(y);

    if (xi < 0 || xi >= config.PW || yi < 0 || yi >= config.PH) {
      continue;
    }

    const index = yi * config.PW + xi;
    buffer[index] = eased > 0.82
      ? particle.ch
      : RAMP[clamp(Math.floor(eased * RAMP.length), 1, RAMP.length - 1)];
  }

  const rows: string[] = [];
  for (let y = 0; y < config.PH; y += 1) {
    rows.push(buffer.slice(y * config.PW, (y + 1) * config.PW).join(""));
  }
  return rows.join("\n");
}

function renderStars(runtime: RuntimePlanet, starEl: HTMLPreElement, elapsed: number, width: number): void {
  if (elapsed >= runtime.nextTwinkle && runtime.stars.length > 0) {
    runtime.twIdx = runtime.stars[Math.floor(Math.random() * runtime.stars.length)].idx;
    runtime.twStart = elapsed;
    runtime.nextTwinkle = elapsed + 4 + Math.random() * 7;
  }

  const delta = elapsed - runtime.twStart;
  const active = runtime.twIdx >= 0 && delta < 0.85;
  if (!active) {
    if (!runtime.starDrawn) {
      starEl.textContent = runtime.starBase;
      starEl.style.textShadow = "none";
      runtime.starDrawn = true;
    }
    return;
  }

  runtime.starDrawn = false;
  const envelope = Math.sin(Math.PI * delta / 0.85);
  const ch = envelope > 0.62 ? "*" : envelope > 0.32 ? "+" : ".";
  const col = runtime.twIdx % width;
  const row = Math.floor(runtime.twIdx / width);
  const rows = runtime.starBaseRows.slice();
  const line = rows[row] ?? "";
  rows[row] = line.slice(0, col) + ch + line.slice(col + 1);
  starEl.textContent = rows.join("\n");
  starEl.style.textShadow = `0 0 6px rgba(150,134,240,${(0.5 * envelope).toFixed(2)})`;
}

function glitchRows(rows: readonly string[], elapsed: number, height: number): string[] {
  const random = makeRandom(Math.floor(elapsed * 1000) >>> 0);
  const out = rows.slice();
  const row = Math.floor(random() * height);
  const shift = random() > 0.5 ? 1 : -1;
  const line = out[row] ?? "";
  out[row] = shift > 0 ? ` ${line.slice(0, -1)}` : `${line.slice(1)} `;

  if (random() > 0.6) {
    const nextRow = Math.min(height - 1, row + 1);
    const nextLine = out[nextRow] ?? "";
    out[nextRow] = shift > 0 ? ` ${nextLine.slice(0, -1)}` : `${nextLine.slice(1)} `;
  }

  return out;
}

function setGlow(preEl: HTMLPreElement, on: boolean, elapsed: number): void {
  if (on) {
    preEl.style.transform = `translateX(${(Math.sin(elapsed * 70) * 0.7).toFixed(2)}px)`;
    preEl.style.textShadow = "0 0 6px rgba(150,134,240,.55), 0 0 15px rgba(120,104,220,.30)";
    return;
  }

  preEl.style.transform = "none";
  preEl.style.textShadow = GLYPH_GLOW;
}

function shouldAnimate(variant: AsciiPlanetVariant, animate: boolean | undefined): boolean {
  if (variant === "orb") {
    return animate === true;
  }
  return animate !== false;
}

function shouldShowStars(variant: AsciiPlanetVariant, showStars: boolean | undefined): boolean {
  return variant !== "orb" && showStars !== false;
}

function boxSize(config: PlanetConfig, size: number | undefined): { width: number; height: number } {
  if (config.v === "orb") {
    const resolved = Number(size) || 60;
    return { width: resolved, height: resolved };
  }

  return {
    width: Math.round(config.PW * config.FS * 0.64),
    height: config.PH * config.FS,
  };
}

export function AsciiPlanet({
  variant = "orbit",
  animate,
  showStars,
  size = 60,
  formDuration = 1.6,
  label = "ASCII planet",
}: AsciiPlanetProps) {
  const config = useMemo(() => configForVariant(variant), [variant]);
  const planet = useMemo(() => generatePlanet(config), [config]);
  const dimensions = useMemo(() => boxSize(config, size), [config, size]);
  const preRef = useRef<HTMLPreElement>(null);
  const starRef = useRef<HTMLPreElement>(null);
  const commonStyle: JSX.CSSProperties = {
    position: "absolute",
    inset: 0,
    margin: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--gsv-font-mono), ui-monospace, monospace",
    fontSize: `${config.FS}px`,
    lineHeight: `${config.FS}px`,
    letterSpacing: 0,
    whiteSpace: "pre",
    pointerEvents: "none",
    WebkitFontSmoothing: "none",
  };

  useEffect(() => {
    const preEl = preRef.current;
    const starEl = starRef.current;
    if (!preEl) {
      return;
    }

    const stars = buildStars(config.seed * 7 + 3, config.PW, config.PH);
    const starBaseRows = buildStarRows(stars, config.PW, config.PH);
    const runtime: RuntimePlanet = {
      rows: planet.rows,
      parts: buildParticles(planet.cells, config.seed, config.PW),
      stars,
      starBaseRows,
      starBase: starBaseRows.join("\n"),
      twIdx: -1,
      twStart: -99,
      starDrawn: false,
      nextTwinkle: 2.5 + Math.random() * 4,
      startDelay: 0,
      formedDrawn: false,
      nextGlitch: formDuration + 9 + Math.random() * 5,
      glitchUntil: 0,
    };
    let interval: number | null = null;
    let cancelled = false;

    const draw = () => {
      if (cancelled) {
        return;
      }

      if (shouldShowStars(config.v, showStars) && starEl) {
        starEl.textContent = runtime.starBase;
      }

      if (!shouldAnimate(config.v, animate)) {
        preEl.textContent = runtime.rows.join("\n");
        preEl.style.textShadow = GLYPH_GLOW;
        return;
      }

      const start = Date.now();
      interval = window.setInterval(() => {
        const elapsed = (Date.now() - start) / 1000;

        if (shouldShowStars(config.v, showStars) && starEl) {
          renderStars(runtime, starEl, elapsed, config.PW);
        }

        const localElapsed = elapsed - runtime.startDelay;
        if (localElapsed < formDuration + 0.05) {
          preEl.textContent = buildFormationFrame(runtime, localElapsed, config, formDuration);
          runtime.formedDrawn = false;
          return;
        }

        if (elapsed < runtime.glitchUntil) {
          setGlow(preEl, true, elapsed);
          preEl.textContent = glitchRows(runtime.rows, elapsed, config.PH).join("\n");
          runtime.formedDrawn = false;
          return;
        }

        if (elapsed >= runtime.nextGlitch) {
          runtime.glitchUntil = elapsed + 0.12;
          runtime.nextGlitch = elapsed + 9 + Math.random() * 8;
        }

        if (!runtime.formedDrawn) {
          setGlow(preEl, false, elapsed);
          preEl.textContent = runtime.rows.join("\n");
          runtime.formedDrawn = true;
        }
      }, 40);
    };

    const fontSet = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fontSet?.ready) {
      void fontSet.ready.then(draw);
    } else {
      draw();
    }

    return () => {
      cancelled = true;
      if (interval !== null) {
        window.clearInterval(interval);
      }
    };
  }, [animate, config, formDuration, planet, showStars]);

  return (
    <div
      class="gsv-ascii-planet"
      role="img"
      aria-label={label}
      style={{
        position: "relative",
        width: `${dimensions.width}px`,
        height: `${dimensions.height}px`,
      }}
    >
      <pre
        ref={starRef}
        aria-hidden="true"
        style={{
          ...commonStyle,
          color: "#403a64",
        }}
      />
      <pre
        ref={preRef}
        aria-hidden="true"
        style={{
          ...commonStyle,
          color: GLYPH_COLOR,
          textShadow: GLYPH_GLOW,
        }}
      />
    </div>
  );
}
