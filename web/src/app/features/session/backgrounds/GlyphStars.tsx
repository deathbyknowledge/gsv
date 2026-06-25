// Flickering glyph star field — the GSV desktop's glyph-texture vibe, more
// populated. A sparse set of absolutely-positioned spans with a CSS keyframe
// flicker, positioned/timed by deterministic index math (no Math.random, which
// is unavailable in some render contexts). Subtle periwinkle/grey on transparent.
import { useMemo } from "preact/hooks";

const GLYPHS = ["·", "◦", "✦", "∗", "+", "·", ".", "◦"];
const COUNT = 160;

// cheap deterministic hash → [0,1)
function frac(n: number) {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

const STYLE = `
.gsv-glyph-stars { overflow: hidden; }
.gsv-glyph-stars b {
  position: absolute;
  font-family: var(--gsv-font-mono, ui-monospace, monospace);
  color: var(--accent, #b3aeff);
  line-height: 1;
  pointer-events: none;
  will-change: opacity;
  animation: gsv-tw var(--d) ease-in-out infinite alternate;
  animation-delay: var(--delay);
}
@keyframes gsv-tw {
  0%   { opacity: var(--lo); }
  100% { opacity: var(--hi); }
}
@media (prefers-reduced-motion: reduce) {
  .gsv-glyph-stars b { animation: none; opacity: var(--hi); }
}
`;

export function GlyphStars() {
  const stars = useMemo(() => {
    // Scale density with viewport so small screens aren't over-packed (and
    // render fewer animated nodes on low-power devices).
    const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
    const count = Math.max(60, Math.min(COUNT, Math.round(vw / 9)));
    const out = [];
    for (let i = 0; i < count; i++) {
      const left = frac(i * 12.9898) * 100;
      const top = frac(i * 78.233) * 100;
      const g = GLYPHS[Math.floor(frac(i * 3.17) * GLYPHS.length)];
      const bright = frac(i * 5.71) > 0.8; // ~20% prominent
      const size = bright ? 12 + frac(i * 9.1) * 9 : 5 + frac(i * 2.3) * 4;
      const hi = bright ? 0.34 + frac(i * 1.7) * 0.22 : 0.1 + frac(i * 4.3) * 0.16;
      const lo = hi * (0.18 + frac(i * 6.6) * 0.22);
      const dur = (2.6 + frac(i * 8.8) * 4.4).toFixed(2);
      const delay = (frac(i * 1.31) * -6).toFixed(2);
      out.push({ i, left, top, g, size, hi, lo, dur, delay });
    }
    return out;
  }, []);

  return (
    <div class="gsv-glyph-stars" aria-hidden="true">
      <style>{STYLE}</style>
      {stars.map((s) => (
        <b
          key={s.i}
          style={{
            left: `${s.left.toFixed(2)}%`,
            top: `${s.top.toFixed(2)}%`,
            fontSize: `${s.size.toFixed(1)}px`,
            // CSS custom props consumed by the keyframe
            ["--d" as any]: `${s.dur}s`,
            ["--delay" as any]: `${s.delay}s`,
            ["--hi" as any]: s.hi.toFixed(3),
            ["--lo" as any]: s.lo.toFixed(3),
          }}
        >
          {s.g}
        </b>
      ))}
    </div>
  );
}
