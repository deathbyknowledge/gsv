import {
  AsciiGalaxyScanRenderer,
  GALAXY_SCAN_FINAL_SECONDS,
  shouldReduceGalaxyScanMotion,
  waitForGalaxyScanFonts,
  type GalaxyScanConfig,
} from "../../../components/ui/AsciiGalaxyScan";

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

const EXIT_MS = 260;
const GALAXY_TEXT = "APP";
const GALAXY_COLS = 200;
const GALAXY_ROWS = 72;
const GALAXY_PARTICLES = 3500;
const GALAXY_FRAME_RATE = 30;
const GALAXY_FRAME_MS = 1000 / GALAXY_FRAME_RATE;
const CELL_WIDTH_RATIO = 0.62;
const LINE_HEIGHT_RATIO = 1;
const MEASURE_FONT_SIZE = 100;
const MEASURE_SAMPLE_CHARS = 40;

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
    availableWidth / (GALAXY_COLS * cellWidthRatio),
    availableHeight / (GALAXY_ROWS * LINE_HEIGHT_RATIO),
  );
  const fontSize = Math.max(rawFontSize, 1);
  const cols = rawFontSize >= 1
    ? Math.max(GALAXY_COLS, Math.ceil(availableWidth / (fontSize * cellWidthRatio)))
    : GALAXY_COLS;
  const rows = rawFontSize >= 1
    ? Math.max(GALAXY_ROWS, Math.ceil(availableHeight / (fontSize * LINE_HEIGHT_RATIO)))
    : GALAXY_ROWS;
  return {
    cols,
    rows,
    fontSize,
    width: cols * fontSize * cellWidthRatio,
    height: rows * fontSize * LINE_HEIGHT_RATIO,
  };
}

function applyGalaxyDimensions(
  elements: readonly HTMLPreElement[],
  dimensions: { fontSize: number; width: number; height: number },
): void {
  for (const element of elements) {
    element.style.fontSize = `${dimensions.fontSize}px`;
    element.style.lineHeight = `${dimensions.fontSize * LINE_HEIGHT_RATIO}px`;
    element.style.width = `${dimensions.width}px`;
    element.style.height = `${dimensions.height}px`;
  }
}

function galaxyConfig(cols: number, rows: number): GalaxyScanConfig {
  return {
    text: GALAXY_TEXT,
    cols,
    rows,
    particleCount: GALAXY_PARTICLES,
    frameRate: GALAXY_FRAME_RATE,
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
  const nebula = createElement("pre", "app-launch-galaxy-pre app-launch-galaxy-nebula");
  const stars = createElement("pre", "app-launch-galaxy-pre app-launch-galaxy-stars");
  const foreground = createElement("pre", "app-launch-galaxy-pre app-launch-galaxy-foreground");
  const scanlines = createElement("div", "app-launch-galaxy-texture app-launch-galaxy-scanlines");
  const vignette = createElement("div", "app-launch-galaxy-texture app-launch-galaxy-vignette");
  const copy = createElement("div", "app-launch-copy");
  const status = createElement("span", "app-launch-status");

  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.setAttribute("aria-atomic", "true");
  for (const element of [nebula, stars, foreground, scanlines, vignette]) {
    element.setAttribute("aria-hidden", "true");
  }
  status.textContent = `${options.appName}: Opening app`;
  overlay.setAttribute("aria-label", status.textContent);

  visual.append(nebula, stars, foreground, scanlines, vignette);
  copy.append(status);
  layout.append(visual, copy);
  overlay.append(layout);
  host.append(frameStage, overlay);

  let destroyed = false;
  let completionScheduled = false;
  let completed = false;
  let animationFrame = 0;
  let exitTimer: number | null = null;
  let animationStart = performance.now();
  let latestElapsed = 0;
  let lastFrameTime = 0;
  let cellWidthRatio = CELL_WIDTH_RATIO;
  let measuredConnectedCellWidth = false;
  let renderer: AsciiGalaxyScanRenderer | null = null;
  let rendererCols = 0;
  let rendererRows = 0;
  let rendererReady = false;
  let fontsReady = false;
  const reducedMotion = shouldReduceGalaxyScanMotion();

  const renderGalaxy = (allowGlitch: boolean): void => {
    if (!renderer || !fontsReady) {
      return;
    }
    const elapsed = reducedMotion ? GALAXY_SCAN_FINAL_SECONDS : latestElapsed;
    renderer.renderStars(stars, elapsed);
    renderer.renderFrame(foreground, elapsed, allowGlitch && !reducedMotion);
  };

  const rebuildState = (): boolean => {
    if (!measuredConnectedCellWidth && foreground.isConnected) {
      cellWidthRatio = measureCellWidthRatio(foreground);
      measuredConnectedCellWidth = true;
    }
    const dimensions = dimensionsForVisual(visual, cellWidthRatio);
    applyGalaxyDimensions([nebula, stars, foreground], dimensions);

    const changed = !renderer || rendererCols !== dimensions.cols || rendererRows !== dimensions.rows;
    if (changed) {
      rendererCols = dimensions.cols;
      rendererRows = dimensions.rows;
      renderer = new AsciiGalaxyScanRenderer(galaxyConfig(dimensions.cols, dimensions.rows));
      rendererReady = false;
      nebula.textContent = renderer.nebulaText;
    }

    if (renderer && fontsReady && !rendererReady) {
      renderer.init();
      rendererReady = true;
      renderGalaxy(false);
    }

    return changed;
  };

  const tick = (timestamp: number): void => {
    if (destroyed || completed || reducedMotion) {
      return;
    }

    const changed = rebuildState();
    if (changed || timestamp - lastFrameTime >= GALAXY_FRAME_MS) {
      latestElapsed = (timestamp - animationStart) / 1000;
      lastFrameTime = timestamp;
      renderGalaxy(true);
    }

    animationFrame = window.requestAnimationFrame(tick);
  };

  const resizeObserver = new ResizeObserver(() => {
    rebuildState();
  });
  resizeObserver.observe(visual);
  rebuildState();

  void waitForGalaxyScanFonts().catch(() => undefined).then(() => {
    if (destroyed) {
      return;
    }
    fontsReady = true;
    measuredConnectedCellWidth = false;
    latestElapsed = reducedMotion ? GALAXY_SCAN_FINAL_SECONDS : 0;
    rebuildState();
    if (!reducedMotion) {
      animationStart = performance.now();
      lastFrameTime = 0;
      animationFrame = window.requestAnimationFrame(tick);
    }
  });

  const setPhase = (phase: AppLaunchPhase, message: string): void => {
    if (destroyed || ((completionScheduled || completed) && phase !== "error")) {
      return;
    }
    const label = `${options.appName}: ${message}`;
    status.textContent = label;
    overlay.setAttribute("aria-label", label);
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
      host.classList.remove("is-complete");
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
