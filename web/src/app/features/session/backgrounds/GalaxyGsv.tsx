// Particle galaxy that drifts and forms into the GSV mark.
// Re-implemented (lean) from the canonical ASCII galaxy asset: a log-spiral
// particle disc with exponential radial density that rotates, then morphs into
// the "GSV" glyph sampled from a rendered canvas. Rendered as glowing dots on a
// single <canvas> sized to its parent; one rAF loop; cleaned up on unmount.
import { useEffect, useRef } from "preact/hooks";

// — galaxy params (mirror the source asset) —
const ARMS = 2;
const TWIST = 5.2;
const PA = -0.5; // position angle
const INCL = 0.5; // disc inclination
const ROTRATE = 0.085; // slow, mysterious drift
const TOTAL = 1800; // particle budget (lean — asset used 3500 on a 200×72 grid)

// timeline (seconds): soft formation → brief breath → slow morph → hold
const T_FORM = 4.5;
const T_DANCE = 5.2;
const T_MORPH = 10.5;

// deterministic LCG so layout is stable (no Math.random reliance for shape)
function mk(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoother = (x: number) => {
  x = clamp01(x);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const ease = (x: number) => {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
};
const easeOut = (x: number) => {
  x = clamp01(x);
  return 1 - (1 - x) * (1 - x);
};

type Particle = {
  r: number; // galaxy radius (grid units)
  a0: number; // base angle
  b: number; // base brightness
  sx: number; // scatter start x (grid units, centered)
  sy: number;
  jit: number; // shimmer phase
  core: boolean; // becomes part of the GSV glyph
  gx: number; // glyph target x
  gy: number;
};

// Sample the "GSV" glyph into a set of points (centered, grid units).
function sampleGSV(maxR: number): { x: number; y: number }[] {
  const fs = 48,
    GAP = 26,
    PAD = 14;
  const W = 300,
    H = fs + PAD * 2;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return [];
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${fs}px ui-monospace, monospace`;
  const gW = ctx.measureText("G").width,
    sW = ctx.measureText("S").width,
    vW = ctx.measureText("V").width;
  const totalW = gW + GAP + sW + GAP + vW;
  let xOff = (W - totalW) / 2;
  const baseline = PAD + fs * 0.8;
  ctx.fillText("G", xOff, baseline);
  xOff += gW + GAP;
  ctx.fillText("S", xOff, baseline);
  xOff += sW + GAP;
  ctx.fillText("V", xOff, baseline);
  const img = ctx.getImageData(0, 0, W, H).data;
  // scale glyph to sit inside the galaxy radius (grid units), sample sparsely
  const sc = (maxR * 1.7) / W;
  const pts: { x: number; y: number }[] = [];
  for (let y = 0; y < H; y += 2)
    for (let x = 0; x < W; x += 2) {
      if (img[(y * W + x) * 4] > 128)
        pts.push({ x: (x - W / 2) * sc, y: (y - H / 2) * sc });
    }
  return pts;
}

export function GalaxyGsv() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    // palette (kept inline — mirrors gsv-tokens.css)
    const ACCENT = "179,174,255"; // --accent #b3aeff
    const BRIGHT = "203,199,255"; // --accent-bright #cbc7ff

    const cosP = Math.cos(PA),
      sinP = Math.sin(PA);
    const ASPECTY = 1.0; // canvas is roughly square-ish; keep disc circular-ish

    // — build particle disc (deterministic) —
    const rnd = mk(91);
    const maxR = 56; // grid-unit radius (scaled to px at draw time)
    const parts: Particle[] = [];
    let guard = 0;
    while (parts.length < TOTAL && guard < TOTAL * 80) {
      guard++;
      const r = maxR * Math.pow(rnd(), 0.6);
      const a = rnd() * Math.PI * 2;
      const rn = r / maxR;
      const arm = Math.cos(ARMS * a - TWIST * Math.log(r + 2));
      const armB = Math.pow(Math.max(0, arm), 2.6);
      const prob =
        Math.exp(-rn * 2.0) * (0.12 + 0.95 * armB) +
        0.55 * Math.exp(-(rn * rn) * 7);
      if (rnd() < Math.min(1, prob * 1.5)) {
        // galaxy position at rot=0 (centered grid units)
        const dx = r * Math.cos(a),
          dy = r * Math.sin(a);
        const gx0 = dx * cosP - dy * INCL * sinP;
        const gy0 = (dx * sinP + dy * INCL * cosP) / ASPECTY;
        const scale = 1.35 + rnd() * 0.55;
        parts.push({
          r,
          a0: a,
          b: 0.22 + 0.78 * Math.min(1, prob * 1.5) * (0.7 + 0.3 * rnd()),
          sx: gx0 * scale + (rnd() - 0.5) * 8,
          sy: gy0 * scale + (rnd() - 0.5) * 4,
          jit: rnd(),
          core: false,
          gx: 0,
          gy: 0,
        });
      }
    }

    // assign GSV glyph targets to the most-central particles (least travel)
    const targets = sampleGSV(maxR);
    const sorted = parts
      .slice()
      .sort((A, B) => Math.abs(A.r) - Math.abs(B.r));
    const nCore = Math.min(targets.length, sorted.length);
    const coreSet = sorted.slice(0, nCore);
    coreSet.sort((A, B) => A.a0 - B.a0);
    targets.sort((A, B) => A.x - B.x || A.y - B.y);
    for (let i = 0; i < nCore; i++) {
      coreSet[i].core = true;
      coreSet[i].gx = targets[i].x;
      coreSet[i].gy = targets[i].y;
    }

    // — sizing —
    let cx = 0,
      cy = 0,
      unit = 1; // px per grid unit
    const fit = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = w / 2;
      cy = h / 2;
      // scale the galaxy to read large in its zone: fill ~115% of the smaller
      // dimension, but lean toward the width so the disc + "GSV" feel present.
      // capped so a very tall/narrow container can't blow it past the height.
      const target = Math.min(Math.max(w * 0.62, Math.min(w, h) * 1.15), h * 1.1);
      unit = target / (maxR * 2);
    };
    fit();

    const ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            fit();
            if (reduced) drawStatic();
          })
        : null;
    ro?.observe(canvas);

    const rotAt = (t: number) => {
      if (t <= T_DANCE) return ROTRATE * t;
      const k = Math.min(1, (t - T_DANCE) / (T_MORPH - T_DANCE));
      return ROTRATE * (T_DANCE + 0.8 * easeOut(Math.min(1, k / 0.6)));
    };

    // galaxy screen position (px) for particle p at rotation rot
    const gpos = (p: Particle, rot: number) => {
      const a = p.a0 + rot;
      const dx = p.r * Math.cos(a),
        dy = p.r * Math.sin(a);
      const u = dx * cosP - dy * INCL * sinP;
      const v = (dx * sinP + dy * INCL * cosP) / ASPECTY;
      return { x: cx + u * unit, y: cy + v * unit };
    };

    const dot = (x: number, y: number, b: number, core: boolean) => {
      const rad = core ? 1.4 : 1.0 + b * 0.7;
      const col = core || b > 0.7 ? BRIGHT : ACCENT;
      // soft glow
      ctx.fillStyle = `rgba(${col},${(b * 0.32).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, rad * 2.4, 0, 6.2832);
      ctx.fill();
      // core
      ctx.fillStyle = `rgba(${col},${Math.min(1, b).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, 6.2832);
      ctx.fill();
    };

    const renderFrame = (elapsed: number) => {
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const t = Math.min(elapsed, T_MORPH);
      const rot = rotAt(t);
      const morphK = (t - T_DANCE) / (T_MORPH - T_DANCE);

      for (const p of parts) {
        const g = gpos(p, rot);
        let x: number, y: number, b: number;

        if (t < T_FORM) {
          // soft radius-staggered fade-in: core first, arms bloom outward
          const ft = t / T_FORM;
          const rNorm = Math.min(1, p.r / maxR);
          const start = rNorm * 0.55;
          const local = (ft - start) / (1 - start * 0.6);
          if (local <= 0) continue;
          const e = smoother(Math.min(1, local));
          x = (cx + p.sx * unit) + (g.x - (cx + p.sx * unit)) * e;
          y = (cy + p.sy * unit) + (g.y - (cy + p.sy * unit)) * e;
          const shimmer = 0.82 + 0.18 * Math.sin(p.jit * 6.283 + elapsed * 3.2);
          b = p.b * smoother(Math.min(1, local * 1.05)) * shimmer;
        } else if (t < T_DANCE) {
          x = g.x;
          y = g.y;
          b = p.b;
        } else {
          // morph: core particles flow to glyph; outer gas fades in place
          const ep = ease(Math.min(1, morphK));
          if (p.core) {
            x = g.x + (cx + p.gx * unit - g.x) * ep;
            y = g.y + (cy + p.gy * unit - g.y) * ep;
            b = p.b * (1 - ep) + 1.0 * ep;
          } else {
            const fade = ease(Math.min(1, morphK * 1.3));
            b = p.b * (1 - fade);
            x = g.x;
            y = g.y;
            if (b < 0.06) continue;
          }
        }
        if (b < 0.05) continue;
        dot(x, y, b, p.core && morphK > 0.5);
      }
    };

    // static formed state for reduced-motion (hold at end of morph)
    function drawStatic() {
      renderFrame(T_MORPH);
    }

    let raf = 0;
    if (reduced) {
      drawStatic();
    } else {
      const base = performance.now();
      const loop = (now: number) => {
        renderFrame((now - base) / 1000);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} class="gsv-galaxy" aria-hidden="true" />;
}
