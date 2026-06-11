export type AppLaunchPhase = "opening" | "session" | "frame" | "runtime" | "ready" | "error";

export type AppLaunchLoader = {
  element: HTMLElement;
  attachIframe: (iframe: HTMLIFrameElement) => void;
  setPhase: (phase: AppLaunchPhase, message: string) => void;
  setRuntimeStatus: (state: string, message?: string) => void;
  complete: () => void;
  fail: (message: string) => void;
  destroy: () => void;
};

type Point = {
  x: number;
  y: number;
};

type BlackholeParticle = {
  finalGlyph: string | null;
  starGlyph: string;
  start: Point;
  final: Point;
  burst: Point;
  angle: number;
  consumeDelay: number;
  order: number;
  ring: boolean;
};

type BlackholeState = {
  cols: number;
  rows: number;
  center: Point;
  radius: number;
  particles: BlackholeParticle[];
  textParticles: BlackholeParticle[];
  ringParticles: BlackholeParticle[];
};

const FORMING_FRAMES = 48;
const CONSUMING_FRAMES = 56;
const COLLAPSING_FRAMES = 24;
const EXPLODING_FRAMES = 60;
const FINAL_HOLD_FRAMES = 15;
const TOTAL_FRAMES = FORMING_FRAMES + CONSUMING_FRAMES + COLLAPSING_FRAMES + EXPLODING_FRAMES + FINAL_HOLD_FRAMES;
const FRAME_MS = 30;
const EXIT_MS = 260;
const TERMINAL_COLS = 80;
const TERMINAL_ROWS = 42;
const CELL_WIDTH_RATIO = 0.62;
const LINE_HEIGHT_RATIO = 1.08;
const MEASURE_FONT_SIZE = 100;
const MEASURE_SAMPLE_CHARS = 40;
const AMBIENT_STAR_DENSITY = 0.018;
const MIN_AMBIENT_STARS = 72;
const MAX_AMBIENT_STARS = 220;
const STAR_GLYPHS = ["*", ".", "'", "`"] as const;
const RING_GLYPHS = [".", "o", "O", "@", "O", "o"] as const;
// Inspired by the terminaltexteffects blackhole: https://github.com/ChrisBuilds/terminaltexteffects
const DEFAULT_TERMINAL_TEXT_LINES = [
  "",
  "             ________________________________________________",
  "            /                                                \\",
  "           |    _________________________________________     |",
  "           |   |                                         |    |",
  "           |   |  $ gsv client                           |    |",
  "           |   |                                         |    |",
  "           |   |     .g8\"\"\"bgd   .M\"\"\"bgd `7MMF'   `7MF' |    |",
  "           |   |   .dP'     `M  ,MI    \"Y   `MA     ,V   |    |",
  "           |   |   dM'       `  `MMb.        VM:   ,V    |    |",
  "           |   |   MM             `YMMNq.     MM.  M'    |    |",
  "           |   |   MM.    `7MMF'.     `MM     `MM A'     |    |",
  "           |   |   `Mb.     MM  Mb     dM      :MM;      |    |",
  "           |   |     `\"bmmmdPY  P\"Ybmmd\"        VF       |    |",
  "           |   |                                         |    |",
  "           |   |  Welcome to the future.                 |    |",
  "           |   |  by Humans & Machines, Inc.             |    |",
  "           |   |_________________________________________|    |",
  "           |                                                  |",
  "            \\_________________________________________________/",
  "                   \\___________________________________/",
  "                ___________________________________________",
  "             _-'    .-.-.-.-.-.-.-.-.-.-.-.-.-.-.-.-.  --- `-_",
  "          _-'.-.-. .---.-.-.-.-.-.-.-.-.-.-.-.-.-.-.--.  .-.-.`-_",
  "       _-'.-.-.-. .---.-.-.-.-.-.-.-.-.-.-.-.-.-.-.-`__`. .-.-.-.`-_",
  "    _-'.-.-.-.-. .-----.-.-.-.-.-.-.-.-.-.-.-.-.-.-.-----. .-.-.-.-.`-_",
  " _-'.-.-.-.-.-. .---.-. .-------------------------. .-.---. .---.-.-.-.`-_",
  ":-------------------------------------------------------------------------:",
  "`---._.-------------------------------------------------------------._.---'",
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function inOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function inExpo(t: number): number {
  return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}

function outExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function inCubic(t: number): number {
  return t * t * t;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(values: readonly T[], rng: () => number): T {
  return values[Math.floor(rng() * values.length)] ?? values[0];
}

function randomRange(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

function circlePoint(center: Point, radius: number, angle: number): Point {
  return {
    x: center.x + Math.cos(angle) * radius * 2,
    y: center.y + Math.sin(angle) * radius,
  };
}

function randomCanvasPoint(cols: number, rows: number, rng: () => number): Point {
  return {
    x: rng() * Math.max(cols - 1, 1),
    y: rng() * Math.max(rows - 1, 1),
  };
}

function createTextParticles(
  cols: number,
  rows: number,
  rng: () => number,
): BlackholeParticle[] {
  const textWidth = DEFAULT_TERMINAL_TEXT_LINES.reduce((width, line) => Math.max(width, line.length), 0);
  const startX = Math.max(Math.floor((cols - textWidth) / 2), 0);
  const startY = Math.max(Math.floor((rows - DEFAULT_TERMINAL_TEXT_LINES.length) / 2), 0);
  const particles: BlackholeParticle[] = [];
  for (let lineIndex = 0; lineIndex < DEFAULT_TERMINAL_TEXT_LINES.length; lineIndex += 1) {
    const line = DEFAULT_TERMINAL_TEXT_LINES[lineIndex] ?? "";
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const glyph = line[charIndex];
      if (!glyph || glyph === " ") {
        continue;
      }
      const final = {
        x: startX + charIndex,
        y: startY + lineIndex,
      };
      const explosionAngle = randomRange(rng, 0, Math.PI * 2);
      particles.push({
        finalGlyph: glyph,
        starGlyph: pick(STAR_GLYPHS, rng),
        start: randomCanvasPoint(cols, rows, rng),
        final,
        burst: circlePoint(final, 3, explosionAngle),
        angle: 0,
        consumeDelay: Math.floor(randomRange(rng, 0, 16)),
        order: particles.length,
        ring: false,
      });
    }
  }
  return particles;
}

function createAmbientStarParticles(
  cols: number,
  rows: number,
  rng: () => number,
  orderOffset: number,
): BlackholeParticle[] {
  const count = clamp(
    Math.round(cols * rows * AMBIENT_STAR_DENSITY),
    MIN_AMBIENT_STARS,
    MAX_AMBIENT_STARS,
  );
  const particles: BlackholeParticle[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = randomCanvasPoint(cols, rows, rng);
    const explosionAngle = randomRange(rng, 0, Math.PI * 2);
    particles.push({
      finalGlyph: null,
      starGlyph: pick(STAR_GLYPHS, rng),
      start,
      final: start,
      burst: circlePoint(start, 3, explosionAngle),
      angle: 0,
      consumeDelay: Math.floor(randomRange(rng, 0, 18)),
      order: orderOffset + index,
      ring: false,
    });
  }
  return particles;
}

function createBlackholeState(cols: number, rows: number, seed: string): BlackholeState {
  const stateSeed = hashSeed(`${seed}:${cols}:${rows}`);
  const rng = createRng(stateSeed);
  const center = {
    x: (cols - 1) / 2,
    y: (rows - 1) / 2,
  };
  const radius = Math.max(Math.min(Math.round(cols * 0.3), Math.round(rows * 0.2)), 3);
  const textParticles = createTextParticles(cols, rows, rng);
  const ambientParticles = createAmbientStarParticles(cols, rows, rng, textParticles.length);
  const shuffledIndices = textParticles.map((_, index) => index);
  for (let index = shuffledIndices.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffledIndices[index], shuffledIndices[swapIndex]] = [shuffledIndices[swapIndex], shuffledIndices[index]];
  }
  const ringCount = Math.min(Math.max(Math.floor(radius) * 3, 1), textParticles.length);
  const ringParticles: BlackholeParticle[] = [];
  for (let index = 0; index < ringCount; index += 1) {
    const particleIndex = shuffledIndices[index] ?? index;
    const particle = textParticles[particleIndex];
    if (!particle) {
      continue;
    }
    const angle = (Math.PI * 2 * index) / ringCount;
    particle.ring = true;
    particle.angle = angle;
    ringParticles.push(particle);
  }
  return {
    cols,
    rows,
    center,
    radius,
    particles: [...textParticles, ...ambientParticles],
    textParticles,
    ringParticles,
  };
}

function createGrid(cols: number, rows: number): { chars: string[][]; priority: number[][] } {
  const chars: string[][] = [];
  const priority: number[][] = [];
  for (let y = 0; y < rows; y += 1) {
    chars.push(Array.from({ length: cols }, () => " "));
    priority.push(Array.from({ length: cols }, () => 0));
  }
  return { chars, priority };
}

function plot(
  grid: { chars: string[][]; priority: number[][] },
  point: Point,
  glyph: string,
  priority: number,
): void {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (y < 0 || y >= grid.chars.length || x < 0 || x >= (grid.chars[y]?.length ?? 0)) {
    return;
  }
  if ((grid.priority[y]?.[x] ?? 0) > priority) {
    return;
  }
  grid.chars[y][x] = glyph;
  grid.priority[y][x] = priority;
}

function particlePoint(from: Point, to: Point, amount: number): Point {
  return {
    x: lerp(from.x, to.x, amount),
    y: lerp(from.y, to.y, amount),
  };
}

function shouldRenderLooseParticle(particle: BlackholeParticle): boolean {
  return !particle.ring && (!particle.finalGlyph || particle.order % 3 === 0);
}

function looseParticleGlyph(particle: BlackholeParticle): string {
  return particle.finalGlyph ? "." : particle.starGlyph;
}

function renderStarfield(state: BlackholeState, grid: { chars: string[][]; priority: number[][] }): void {
  for (const particle of state.particles) {
    if (!shouldRenderLooseParticle(particle)) {
      continue;
    }
    plot(grid, particle.start, looseParticleGlyph(particle), 1);
  }
}

function renderFinalText(state: BlackholeState, grid: { chars: string[][]; priority: number[][] }): void {
  for (const particle of state.textParticles) {
    if (particle.finalGlyph) {
      plot(grid, particle.final, particle.finalGlyph, 5);
    }
  }
}

function renderBlackholeFrame(state: BlackholeState, rawFrame: number): string {
  const frame = clamp(rawFrame, 0, TOTAL_FRAMES - 1);
  const grid = createGrid(state.cols, state.rows);

  if (frame < FORMING_FRAMES) {
    const globalT = frame / Math.max(FORMING_FRAMES - 1, 1);
    renderStarfield(state, grid);
    for (let slot = 0; slot < state.ringParticles.length; slot += 1) {
      const particle = state.ringParticles[slot];
      if (!particle) {
        continue;
      }
      const delay = (slot / Math.max(state.ringParticles.length, 1)) * 0.55;
      const amount = clamp((globalT - delay) / (1 - delay), 0, 1);
      if (amount <= 0) {
        continue;
      }
      const ringPoint = circlePoint(state.center, state.radius, particle.angle);
      plot(grid, particlePoint(particle.start, ringPoint, inOutSine(amount)), "*", 3);
    }
  } else if (frame < FORMING_FRAMES + CONSUMING_FRAMES) {
    const local = frame - FORMING_FRAMES;
    const phase = local / Math.max(CONSUMING_FRAMES - 1, 1);
    for (const particle of state.ringParticles) {
      const angle = particle.angle + phase * 8 * Math.PI;
      plot(grid, circlePoint(state.center, state.radius, angle), "*", 4);
    }
    for (const particle of state.particles) {
      if (!shouldRenderLooseParticle(particle)) {
        continue;
      }
      const delay = particle.consumeDelay / 20;
      const amount = clamp((phase - delay) / (1 - delay), 0, 1);
      if (amount >= 0.94) {
        continue;
      }
      plot(grid, particlePoint(particle.start, state.center, inExpo(amount)), looseParticleGlyph(particle), 2);
    }
  } else if (frame < FORMING_FRAMES + CONSUMING_FRAMES + COLLAPSING_FRAMES) {
    const local = frame - FORMING_FRAMES - CONSUMING_FRAMES;
    const phase = local / Math.max(COLLAPSING_FRAMES - 1, 1);
    const expand = phase < 0.4;
    const amount = expand ? phase / 0.4 : (phase - 0.4) / 0.6;
    const radius = expand
      ? lerp(state.radius, state.radius + 3, inExpo(amount))
      : lerp(state.radius + 3, 0, inExpo(amount));
    const glyph = RING_GLYPHS[Math.floor(local / 2) % RING_GLYPHS.length] ?? "@";
    for (const particle of state.ringParticles) {
      plot(grid, circlePoint(state.center, radius, particle.angle + phase * 4 * Math.PI), glyph, 5);
    }
    if (phase > 0.55) {
      plot(grid, state.center, RING_GLYPHS[local % RING_GLYPHS.length] ?? "@", 6);
    }
  } else if (frame < FORMING_FRAMES + CONSUMING_FRAMES + COLLAPSING_FRAMES + EXPLODING_FRAMES) {
    const local = frame - FORMING_FRAMES - CONSUMING_FRAMES - COLLAPSING_FRAMES;
    const phase = local / Math.max(EXPLODING_FRAMES - 1, 1);
    for (const particle of state.particles) {
      if (particle.finalGlyph) {
        const point = phase <= 0.35
          ? particlePoint(state.center, particle.burst, outExpo(phase / 0.35))
          : particlePoint(particle.burst, particle.final, inCubic((phase - 0.35) / 0.65));
        plot(grid, point, particle.finalGlyph, 5);
      }
    }
  } else {
    renderFinalText(state, grid);
  }

  return grid.chars.map((row) => row.join("")).join("\n");
}

function renderReducedFrame(state: BlackholeState): string {
  const grid = createGrid(state.cols, state.rows);
  renderFinalText(state, grid);
  return grid.chars.map((row) => row.join("")).join("\n");
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  return element;
}

function measureCellWidthRatio(element: HTMLElement): number {
  const body = element.ownerDocument.body;
  if (!body || !element.isConnected) {
    return CELL_WIDTH_RATIO;
  }
  const style = window.getComputedStyle(element);
  const probe = element.ownerDocument.createElement("span");
  probe.textContent = "M".repeat(MEASURE_SAMPLE_CHARS);
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  probe.style.top = "-9999px";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = `${MEASURE_FONT_SIZE}px`;
  probe.style.fontStyle = style.fontStyle;
  probe.style.fontWeight = style.fontWeight;
  probe.style.letterSpacing = "0";
  body.append(probe);
  const cellWidth = probe.getBoundingClientRect().width / MEASURE_SAMPLE_CHARS;
  probe.remove();
  const ratio = cellWidth / MEASURE_FONT_SIZE;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : CELL_WIDTH_RATIO;
}

function dimensionsForVisual(
  element: HTMLElement,
  cellWidthRatio: number,
): { cols: number; rows: number; fontSize: number; width: number; height: number } {
  const bounds = element.getBoundingClientRect();
  const availableWidth = Math.max(bounds.width, 1);
  const availableHeight = Math.max(bounds.height, 1);
  const rawFontSize = Math.min(
    availableWidth / (TERMINAL_COLS * cellWidthRatio),
    availableHeight / (TERMINAL_ROWS * LINE_HEIGHT_RATIO),
  );
  const fontSize = Math.max(rawFontSize, 1);
  const cols = rawFontSize >= 1
    ? Math.max(TERMINAL_COLS, Math.ceil(availableWidth / (fontSize * cellWidthRatio)))
    : TERMINAL_COLS;
  const rows = rawFontSize >= 1
    ? Math.max(TERMINAL_ROWS, Math.ceil(availableHeight / (fontSize * LINE_HEIGHT_RATIO)))
    : TERMINAL_ROWS;
  return {
    cols,
    rows,
    fontSize,
    width: cols * fontSize * cellWidthRatio,
    height: rows * fontSize * LINE_HEIGHT_RATIO,
  };
}

function defaultRuntimeMessage(state: string): string {
  if (state === "connecting") {
    return "Connecting app";
  }
  if (state === "connected") {
    return "Opening app";
  }
  if (state === "loading") {
    return "Loading app";
  }
  if (state === "reconnecting") {
    return "Reconnecting app";
  }
  if (state === "error") {
    return "App unavailable";
  }
  return "Booting app";
}

function runtimePhase(state: string): AppLaunchPhase {
  if (state === "error") {
    return "error";
  }
  if (state === "ready") {
    return "ready";
  }
  return "runtime";
}

export function createAppLaunchLoader(options: { appName: string; route: string; seed: string }): AppLaunchLoader {
  const host = createElement("div", "app-launch-host");
  const frameStage = createElement("div", "app-launch-iframe-stage");
  const overlay = createElement("div", "app-launch-overlay");
  const layout = createElement("div", "app-launch-layout");
  const visual = createElement("div", "app-launch-visual");
  const pre = createElement("pre", "app-launch-blackhole-frame");
  const copy = createElement("div", "app-launch-copy");
  const kicker = createElement("p", "app-launch-kicker");
  const title = createElement("h1", "app-launch-title");
  const stage = createElement("p", "app-launch-stage");
  const rail = createElement("div", "app-launch-phase-rail");

  host.dataset.appLaunchPhase = "opening";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.setAttribute("aria-atomic", "true");
  pre.setAttribute("aria-hidden", "true");
  kicker.textContent = "launch sequence";
  title.textContent = options.appName;
  stage.textContent = "Opening app";
  rail.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) {
    rail.append(document.createElement("span"));
  }

  visual.append(pre);
  copy.append(kicker, title, stage, rail);
  layout.append(visual, copy);
  overlay.append(layout);
  host.append(frameStage, overlay);

  let destroyed = false;
  let completionScheduled = false;
  let completed = false;
  let animationFrame = 0;
  let exitTimer: number | null = null;
  let animationStart = performance.now();
  let latestFrame = 0;
  let cellWidthRatio = CELL_WIDTH_RATIO;
  let measuredConnectedCellWidth = false;
  let blackholeState: BlackholeState | null = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const rebuildState = (): void => {
    if (!measuredConnectedCellWidth && pre.isConnected) {
      cellWidthRatio = measureCellWidthRatio(pre);
      measuredConnectedCellWidth = true;
    }
    const { cols, rows, fontSize, width, height } = dimensionsForVisual(visual, cellWidthRatio);
    pre.style.fontSize = `${fontSize}px`;
    pre.style.lineHeight = String(LINE_HEIGHT_RATIO);
    pre.style.width = `${width}px`;
    pre.style.height = `${height}px`;
    if (blackholeState?.cols === cols && blackholeState.rows === rows) {
      return;
    }
    blackholeState = createBlackholeState(cols, rows, options.seed || options.route);
    pre.textContent = reducedMotion ? renderReducedFrame(blackholeState) : renderBlackholeFrame(blackholeState, latestFrame);
  };

  const tick = (timestamp: number): void => {
    if (destroyed || completed || reducedMotion) {
      return;
    }
    rebuildState();
    if (blackholeState) {
      latestFrame = Math.floor((timestamp - animationStart) / FRAME_MS);
      pre.textContent = renderBlackholeFrame(blackholeState, latestFrame);
    }
    animationFrame = window.requestAnimationFrame(tick);
  };

  const resizeObserver = new ResizeObserver(() => {
    rebuildState();
  });
  resizeObserver.observe(visual);
  rebuildState();
  if ("fonts" in document) {
    void document.fonts.ready.then(() => {
      if (destroyed) {
        return;
      }
      measuredConnectedCellWidth = false;
      rebuildState();
    });
  }
  if (!reducedMotion) {
    animationFrame = window.requestAnimationFrame(tick);
  }

  const setPhase = (phase: AppLaunchPhase, message: string): void => {
    if (destroyed || ((completionScheduled || completed) && phase !== "error")) {
      return;
    }
    host.dataset.appLaunchPhase = phase;
    stage.textContent = message;
    overlay.setAttribute("aria-label", `${options.appName}: ${message}`);
  };

  const complete = (): void => {
    if (destroyed || completionScheduled || completed) {
      return;
    }
    setPhase("ready", "Ready");
    completionScheduled = true;
    host.classList.add("is-frame-visible", "is-complete");
    exitTimer = window.setTimeout(() => {
      completed = true;
      if (animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      overlay.remove();
    }, EXIT_MS);
  };

  return {
    element: host,
    attachIframe: (iframe) => {
      iframe.classList.add("app-launch-iframe");
      frameStage.replaceChildren(iframe);
      host.classList.add("has-frame", "is-frame-visible");
    },
    setPhase,
    setRuntimeStatus: (state, message) => {
      if (state === "ready") {
        complete();
        return;
      }
      const phase = runtimePhase(state);
      if (phase === "error") {
        setPhase("error", message || defaultRuntimeMessage(state));
        return;
      }
      setPhase(phase, message || defaultRuntimeMessage(state));
    },
    complete,
    fail: (message) => {
      if (destroyed) {
        return;
      }
      completionScheduled = false;
      completed = false;
      if (exitTimer !== null) {
        window.clearTimeout(exitTimer);
        exitTimer = null;
      }
      host.classList.add("is-error");
      setPhase("error", message);
    },
    destroy: () => {
      destroyed = true;
      if (animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      if (exitTimer !== null) {
        window.clearTimeout(exitTimer);
        exitTimer = null;
      }
      resizeObserver.disconnect();
    },
  };
}
