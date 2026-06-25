import type { JSX } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import "./AsciiGalaxyScan.css";

export type AsciiGalaxyScanProps = {
  text?: string;
  animate?: boolean;
  showNebula?: boolean;
  showStars?: boolean;
  showTexture?: boolean;
  showReplay?: boolean;
  pauseWhenOffscreen?: boolean;
  respectReducedMotion?: boolean;
  className?: string;
  label?: string;
  cols?: number;
  rows?: number;
  particleCount?: number;
  frameRate?: number;
  fontSize?: number;
};

type Point = {
  x: number;
  y: number;
};

type GalaxyParticle = {
  r: number;
  a0: number;
  gb: number;
  sx: number;
  sy: number;
  jitter: number;
  glyph: string;
  core: boolean;
  gx: number;
  gy: number;
};

type Star = {
  idx: number;
  phase: number;
  rate: number;
  bright: boolean;
  base: number;
};

type GalaxyScanConfig = {
  text: string;
  cols: number;
  rows: number;
  particleCount: number;
  frameRate: number;
};

const RAMP = " `·.:+=o*Ø#@";
const LETTER_GLYPHS = "@#8&ØB0%HNø6";
const PA = -0.5;
const INCL = 0.5;
const ARMS = 2;
const TWIST = 5.2;
const MAX_RADIUS = 56;
const ASPECT_Y = 1.85;
const ROT_RATE = 0.085;
const T_FORM = 5.0;
const T_SETTLE = 0.85;
const T_SETTLE_END = T_FORM + T_SETTLE;
const T_DANCE = T_SETTLE_END + 0.6;
const T_MORPH = 11.4 + T_SETTLE;
const TARGET_SCALE = 0.6;
const FOREGROUND_GLOW = "0 0 5px rgba(140,120,235,.55),0 0 14px rgba(110,95,209,.28)";

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function clamp(value: number, min = 0, max = 1): number {
  return value < min ? min : value > max ? max : value;
}

function ease(value: number): number {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

function easeOut(value: number): number {
  const x = clamp(value);
  return 1 - (1 - x) * (1 - x);
}

function smoother(value: number): number {
  const x = clamp(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function waitForFonts(): Promise<unknown> {
  const fontSet = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fontSet) {
    return Promise.resolve();
  }

  return Promise.all([
    fontSet.load('48px "Departure Mono"'),
    fontSet.ready,
  ]);
}

function shouldReduceMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

class AsciiGalaxyScanRenderer {
  private readonly cx: number;
  private readonly cy: number;
  private readonly cosP = Math.cos(PA);
  private readonly sinP = Math.sin(PA);
  private particles: GalaxyParticle[] = [];
  private stars: Star[] = [];
  private readonly starBuffer: string[];
  private readonly brightness: Float32Array;
  private readonly chars: string[];
  private initialized = false;
  readonly nebulaText: string;

  constructor(private readonly config: GalaxyScanConfig) {
    this.cx = (config.cols - 1) / 2;
    this.cy = (config.rows - 1) / 2;
    this.starBuffer = new Array(config.cols * config.rows);
    this.brightness = new Float32Array(config.cols * config.rows);
    this.chars = new Array(config.cols * config.rows);
    this.nebulaText = this.buildNebula();
  }

  init(): void {
    if (this.initialized) {
      return;
    }

    const random = makeRandom(91);
    const particles: GalaxyParticle[] = [];
    let guard = 0;

    while (particles.length < this.config.particleCount && guard < this.config.particleCount * 60) {
      guard += 1;
      const r = MAX_RADIUS * Math.pow(random(), 0.6);
      const a0 = random() * Math.PI * 2;
      const rn = r / MAX_RADIUS;
      const arm = Math.cos(ARMS * a0 - TWIST * Math.log(r + 2));
      const armBias = Math.pow(Math.max(0, arm), 2.6);
      const probability = Math.exp(-rn * 2.0) * (0.12 + 0.95 * armBias) + 0.55 * Math.exp(-(rn * rn) * 7);

      if (random() >= Math.min(1, probability * 1.5)) {
        continue;
      }

      const galaxy = this.galaxyScreen({ r, a0 }, 0);
      const scale = 1.35 + random() * 0.55;
      const jitterX = (random() - 0.5) * 8;
      const jitterY = (random() - 0.5) * 4;

      particles.push({
        r,
        a0,
        gb: 0.22 + 0.78 * Math.min(1, probability * 1.5) * (0.7 + 0.3 * random()),
        sx: this.cx + (galaxy.x - this.cx) * scale + jitterX,
        sy: this.cy + (galaxy.y - this.cy) * scale + jitterY,
        jitter: random(),
        glyph: LETTER_GLYPHS[Math.floor(random() * LETTER_GLYPHS.length)],
        core: false,
        gx: 0,
        gy: 0,
      });
    }

    this.assignTextTargets(particles);
    this.particles = particles;
    this.stars = this.buildStars();
    this.initialized = true;
  }

  renderStars(starEl: HTMLPreElement, elapsed: number): void {
    const { cols, rows } = this.config;
    this.starBuffer.fill(" ");

    for (const star of this.stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(elapsed * star.rate + star.phase);
      const level = star.base + twinkle * 0.62;
      let char = " ";

      if (star.bright) {
        char = level > 0.95 ? "*" : level > 0.72 ? "+" : level > 0.48 ? "·" : level > 0.27 ? "." : " ";
      } else {
        char = level > 0.8 ? "+" : level > 0.52 ? "·" : level > 0.32 ? "." : " ";
      }

      this.starBuffer[star.idx] = char;
    }

    let output = "";
    for (let y = 0; y < rows; y += 1) {
      let line = "";
      const base = y * cols;
      for (let x = 0; x < cols; x += 1) {
        line += this.starBuffer[base + x];
      }
      output += `${y ? "\n" : ""}${line}`;
    }

    starEl.textContent = output;
  }

  renderFrame(preEl: HTMLPreElement, elapsed: number, allowGlitch: boolean): void {
    const rows = this.buildFrameRows(elapsed);

    if (allowGlitch && elapsed > T_MORPH - 0.6) {
      this.applyGlitch(rows, elapsed, preEl);
    } else {
      this.resetForeground(preEl);
    }

    preEl.textContent = rows.join("\n");
  }

  resetForeground(preEl: HTMLPreElement): void {
    preEl.style.transform = "none";
    preEl.style.textShadow = FOREGROUND_GLOW;
    preEl.style.opacity = "1";
  }

  private galaxyScreen(particle: Pick<GalaxyParticle, "r" | "a0">, rot: number): Point {
    const angle = particle.a0 + rot;
    const dx = particle.r * Math.cos(angle);
    const dy = particle.r * Math.sin(angle);
    const u = dx * this.cosP - dy * INCL * this.sinP;
    const v = dx * this.sinP + dy * INCL * this.cosP;
    return { x: this.cx + u, y: this.cy + v / ASPECT_Y };
  }

  private rotAt(t: number): number {
    if (t <= T_DANCE) {
      return ROT_RATE * t;
    }
    const k = Math.min(1, (t - T_DANCE) / (T_MORPH - T_DANCE));
    return ROT_RATE * (T_DANCE + 0.8 * easeOut(Math.min(1, k / 0.6)));
  }

  private assignTextTargets(particles: GalaxyParticle[]): void {
    const targets = this.sampleTextTargets();
    const rotFinal = this.rotAt(T_DANCE);
    const sortedParticles = particles.slice().sort((a, b) => {
      const ap = this.galaxyScreen(a, rotFinal);
      const bp = this.galaxyScreen(b, rotFinal);
      const da = Math.abs(ap.y - this.cy) * 0.7 + Math.abs(ap.x - this.cx) * 0.3;
      const db = Math.abs(bp.y - this.cy) * 0.7 + Math.abs(bp.x - this.cx) * 0.3;
      return da - db;
    });
    const coreParticles = sortedParticles.slice(0, Math.min(targets.length, sortedParticles.length));
    coreParticles.sort((a, b) => {
      const ap = this.galaxyScreen(a, rotFinal);
      const bp = this.galaxyScreen(b, rotFinal);
      return ap.x - bp.x || ap.y - bp.y;
    });
    targets.sort((a, b) => a.x - b.x || a.y - b.y);

    for (let i = 0; i < coreParticles.length; i += 1) {
      coreParticles[i].core = true;
      coreParticles[i].gx = targets[i].x;
      coreParticles[i].gy = targets[i].y;
    }
  }

  private sampleTextTargets(): Point[] {
    const text = this.config.text.trim() || "GSV";
    const fontSize = 48;
    const letterGap = 30;
    const pad = 16;
    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");

    if (!measureContext) {
      return [];
    }

    measureContext.font = `${fontSize}px "Departure Mono", monospace`;
    const glyphs = Array.from(text);
    const widths = glyphs.map((glyph) => measureContext.measureText(glyph).width);
    const totalWidth = widths.reduce((sum, width) => sum + width, 0) + letterGap * Math.max(0, glyphs.length - 1);
    const canvasWidth = Math.ceil(totalWidth + pad * 2);
    const canvasHeight = fontSize + pad * 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      return [];
    }

    context.fillStyle = "#000";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.fillStyle = "#fff";
    context.textBaseline = "alphabetic";
    context.font = `${fontSize}px "Departure Mono", monospace`;

    let xOffset = pad;
    const baseline = pad + fontSize * 0.8;
    for (let i = 0; i < glyphs.length; i += 1) {
      context.fillText(glyphs[i], xOffset, baseline);
      xOffset += widths[i] + letterGap;
    }

    const image = context.getImageData(0, 0, canvasWidth, canvasHeight).data;
    const points: Point[] = [];
    for (let y = 0; y < canvasHeight; y += 1) {
      for (let x = 0; x < canvasWidth; x += 1) {
        if (image[(y * canvasWidth + x) * 4] > 128) {
          points.push({
            x: this.cx + (x - canvasWidth / 2) * TARGET_SCALE,
            y: this.cy + (y - canvasHeight / 2) * TARGET_SCALE,
          });
        }
      }
    }
    return points;
  }

  private buildStars(): Star[] {
    const stars: Star[] = [];
    const random = makeRandom(137);
    const total = this.config.cols * this.config.rows;

    for (let i = 0; i < total; i += 1) {
      if (random() <= 0.972) {
        continue;
      }

      stars.push({
        idx: i,
        phase: random() * Math.PI * 2,
        rate: 0.7 + random() * 2.4,
        bright: random() > 0.82,
        base: 0.2 + random() * 0.45,
      });
    }

    return stars;
  }

  private buildFrameRows(elapsed: number): string[] {
    const { cols, rows } = this.config;
    const t = Math.min(elapsed, T_MORPH);
    const rot = this.rotAt(t);
    const morphK = (t - T_DANCE) / (T_MORPH - T_DANCE);

    this.brightness.fill(0);
    this.chars.fill(" ");

    for (const particle of this.particles) {
      const galaxy = this.galaxyScreen(particle, rot);
      let x: number;
      let y: number;
      let brightness: number;

      if (t < T_FORM) {
        const state = this.formationState(particle, galaxy, t);
        if (!state) {
          continue;
        }
        x = state.x;
        y = state.y;
        brightness = state.brightness;
      } else if (t < T_SETTLE_END) {
        const settle = easeOut((t - T_FORM) / T_SETTLE);
        const startGalaxy = this.galaxyScreen(particle, this.rotAt(T_FORM));
        const start = this.formationState(particle, startGalaxy, T_FORM);

        if (!start) {
          continue;
        }

        x = start.x + (galaxy.x - start.x) * settle;
        y = start.y + (galaxy.y - start.y) * settle;
        brightness = start.brightness + (particle.gb - start.brightness) * settle;
      } else if (t < T_DANCE) {
        x = galaxy.x;
        y = galaxy.y;
        brightness = particle.gb;
      } else {
        const eased = ease(Math.min(1, morphK));
        if (particle.core) {
          x = galaxy.x + (particle.gx - galaxy.x) * eased;
          y = galaxy.y + (particle.gy - galaxy.y) * eased;
          brightness = particle.gb * (1 - eased) + eased;
        } else {
          const fade = ease(Math.min(1, morphK * 1.3));
          brightness = particle.gb * (1 - fade);
          x = galaxy.x;
          y = galaxy.y;

          if (brightness < 0.07) {
            continue;
          }
        }
      }

      if (brightness < 0.05) {
        continue;
      }

      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || xi >= cols || yi < 0 || yi >= rows) {
        continue;
      }

      const index = yi * cols + xi;
      if (brightness <= this.brightness[index]) {
        continue;
      }

      this.brightness[index] = brightness;
      if (particle.core && morphK > 0.5) {
        this.chars[index] = particle.glyph;
      } else {
        this.chars[index] = RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.floor(brightness * RAMP.length)))];
      }
    }

    const output: string[] = [];
    for (let y = 0; y < rows; y += 1) {
      let line = "";
      const base = y * cols;
      for (let x = 0; x < cols; x += 1) {
        line += this.chars[base + x];
      }
      output.push(line);
    }
    return output;
  }

  private formationState(particle: GalaxyParticle, galaxy: Point, elapsed: number): { x: number; y: number; brightness: number } | null {
    const formT = elapsed / T_FORM;
    const radiusNorm = Math.min(1, particle.r / MAX_RADIUS);
    const start = radiusNorm * 0.55;
    const local = (formT - start) / (1 - start * 0.6);

    if (local <= 0) {
      return null;
    }

    const eased = smoother(Math.min(1, local));
    const shimmer = 0.82 + 0.18 * Math.sin(particle.jitter * Math.PI * 2 + elapsed * 3.2);
    return {
      x: particle.sx + (galaxy.x - particle.sx) * eased,
      y: particle.sy + (galaxy.y - particle.sy) * eased,
      brightness: particle.gb * smoother(Math.min(1, local * 1.05)) * shimmer,
    };
  }

  private applyGlitch(frameRows: string[], elapsed: number, preEl: HTMLPreElement): void {
    const random = makeRandom(Math.floor(elapsed * 1000) >>> 0);
    const burst = elapsed % 3.2 < 0.08;

    if (!burst) {
      this.resetForeground(preEl);
      return;
    }

    const slices = 1 + Math.floor(random() * 2);
    for (let i = 0; i < slices; i += 1) {
      const row = Math.floor(random() * this.config.rows);
      const shift = Math.floor((random() - 0.5) * 8);
      const line = frameRows[row];

      if (shift > 0) {
        frameRows[row] = " ".repeat(shift) + line.slice(0, this.config.cols - shift);
      } else if (shift < 0) {
        frameRows[row] = line.slice(-shift) + " ".repeat(-shift);
      }
    }

    if (random() > 0.62) {
      const row = Math.floor(random() * this.config.rows);
      const noise = "01:+=*·.";
      const cells = frameRows[row].split("");
      for (let x = 0; x < this.config.cols; x += 1) {
        if (cells[x] !== " " && random() > 0.72) {
          cells[x] = noise[Math.floor(random() * noise.length)];
        }
      }
      frameRows[row] = cells.join("");
    }

    preEl.style.transform = `translateX(${((random() - 0.5) * 2.6).toFixed(1)}px)`;
    preEl.style.textShadow = "1px 0 0 rgba(255,90,160,.3),-1px 0 0 rgba(90,200,255,.28),0 0 9px rgba(140,120,235,.55)";
    preEl.style.opacity = (0.9 + random() * 0.1).toFixed(2);
  }

  private buildNebula(): string {
    const { cols, rows } = this.config;
    const random = makeRandom(7);
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const lines: string[] = [];

    for (let y = 0; y < rows; y += 1) {
      let line = "";
      for (let x = 0; x < cols; x += 1) {
        const dx = (x - cx) / cols;
        const dy = (y - cy) / rows;
        let density = Math.exp(-((dx * dx) / 0.05 + (dy * dy) / 0.045));
        density += 0.55 * Math.exp(-(((dx - 0.07) * (dx - 0.07)) / 0.02 + ((dy + 0.05) * (dy + 0.05)) / 0.016));
        density += 0.4 * Math.exp(-(((dx + 0.12) * (dx + 0.12)) / 0.025 + ((dy - 0.06) * (dy - 0.06)) / 0.02));

        const value = random();
        let char = " ";
        if (density > 0.32 && value < density * 0.42) {
          char = density > 0.72 ? (value > 0.62 ? ":" : "·") : ".";
        } else if (value > 0.9955) {
          char = "`";
        }
        line += char;
      }
      lines.push(line);
    }

    return lines.join("\n");
  }
}

function classNames(...parts: readonly (false | null | string | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function AsciiGalaxyScan({
  text = "GSV",
  animate = true,
  showNebula = true,
  showStars = true,
  showTexture = false,
  showReplay = false,
  pauseWhenOffscreen = true,
  respectReducedMotion = true,
  className,
  label,
  cols = 200,
  rows = 72,
  particleCount = 3500,
  frameRate = 30,
  fontSize = 8,
}: AsciiGalaxyScanProps) {
  const config = useMemo<GalaxyScanConfig>(
    () => ({
      text,
      cols,
      rows,
      particleCount,
      frameRate,
    }),
    [cols, frameRate, particleCount, rows, text],
  );
  const renderer = useMemo(() => new AsciiGalaxyScanRenderer(config), [config]);
  const nebulaRef = useRef<HTMLPreElement>(null);
  const starRef = useRef<HTMLPreElement>(null);
  const foregroundRef = useRef<HTMLPreElement>(null);
  const replayRef = useRef<HTMLButtonElement>(null);
  const accessibleLabel = label ?? `${text} ASCII galaxy scan`;
  const rootStyle = {
    "--gsv-ascii-galaxy-font-size": `${fontSize}px`,
  } as JSX.CSSProperties;

  useEffect(() => {
    const nebulaEl = nebulaRef.current;
    const starEl = starRef.current;
    const foregroundEl = foregroundRef.current;
    const replayEl = replayRef.current;

    if (!foregroundEl) {
      return;
    }

    let cancelled = false;
    let raf = 0;
    let visible = true;
    let lastFrame = 0;
    let startedAt = performance.now();
    let replayShown = false;
    const frameMs = 1000 / Math.max(1, frameRate);
    const shouldAnimate = animate && !(respectReducedMotion && shouldReduceMotion());

    const hideReplay = () => {
      replayShown = false;
      if (replayEl) {
        replayEl.style.opacity = "0";
      }
    };

    const replay = () => {
      startedAt = performance.now();
      lastFrame = 0;
      hideReplay();
      renderer.resetForeground(foregroundEl);
      renderer.renderFrame(foregroundEl, 0, false);
      if (showStars && starEl) {
        renderer.renderStars(starEl, 0);
      }
    };

    const loop = (now: number) => {
      if (cancelled) {
        return;
      }

      if (visible && now - lastFrame >= frameMs) {
        lastFrame = now;
        const elapsed = (now - startedAt) / 1000;

        if (showStars && starEl) {
          renderer.renderStars(starEl, elapsed);
        }
        renderer.renderFrame(foregroundEl, elapsed, true);

        if (showReplay && replayEl && !replayShown && elapsed > T_MORPH + 1.5) {
          replayShown = true;
          replayEl.style.opacity = "1";
        }
      }

      raf = window.requestAnimationFrame(loop);
    };

    let observer: IntersectionObserver | null = null;
    if (pauseWhenOffscreen && foregroundEl.parentElement && "IntersectionObserver" in window) {
      observer = new IntersectionObserver((entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
      });
      observer.observe(foregroundEl.parentElement);
    }

    replayEl?.addEventListener("click", replay);

    void waitForFonts().then(() => {
      if (cancelled) {
        return;
      }

      renderer.init();

      if (nebulaEl) {
        nebulaEl.textContent = showNebula ? renderer.nebulaText : "";
      }
      if (showStars && starEl) {
        renderer.renderStars(starEl, 0);
      } else if (starEl) {
        starEl.textContent = "";
      }

      if (!shouldAnimate) {
        renderer.renderFrame(foregroundEl, T_MORPH, false);
        if (showReplay && replayEl) {
          replayEl.style.opacity = "1";
        }
        return;
      }

      startedAt = performance.now();
      raf = window.requestAnimationFrame(loop);
    });

    return () => {
      cancelled = true;
      replayEl?.removeEventListener("click", replay);
      observer?.disconnect();
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [animate, frameRate, pauseWhenOffscreen, renderer, respectReducedMotion, showNebula, showReplay, showStars]);

  return (
    <div class={classNames("gsv-ascii-galaxy", className)} role="img" aria-label={accessibleLabel} style={rootStyle}>
      <pre ref={nebulaRef} class="gsv-ascii-galaxy-pre gsv-ascii-galaxy-nebula" aria-hidden="true" />
      <pre ref={starRef} class="gsv-ascii-galaxy-pre gsv-ascii-galaxy-stars" aria-hidden="true" />
      <pre ref={foregroundRef} class="gsv-ascii-galaxy-pre gsv-ascii-galaxy-foreground" aria-hidden="true" />
      {showTexture ? (
        <>
          <div class="gsv-ascii-galaxy-texture gsv-ascii-galaxy-scanlines" aria-hidden="true" />
          <div class="gsv-ascii-galaxy-texture gsv-ascii-galaxy-vignette" aria-hidden="true" />
        </>
      ) : null}
      {showReplay ? (
        <button ref={replayRef} type="button" class="gsv-ascii-galaxy-replay" aria-label={`Replay ${text} ASCII galaxy scan`}>
          <span class="gsv-ascii-galaxy-replay-icon" aria-hidden="true">↻</span>
          Replay
        </button>
      ) : null}
    </div>
  );
}
