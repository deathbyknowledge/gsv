export type Rgb = [number, number, number];

export type InstrumentPalette = {
  bg: Rgb;
  bgDark: Rgb;
  traceDim: Rgb;
  trace: Rgb;
  alert: Rgb;
  amber: Rgb;
  green: Rgb;
  cyan: Rgb;
  blue: Rgb;
  white: Rgb;
};

export const GSV_INSTRUMENT_PALETTE: InstrumentPalette = {
  bg: [3, 9, 7],
  bgDark: [0, 3, 2],
  traceDim: [22, 92, 69],
  trace: [76, 241, 255],
  alert: [255, 79, 99],
  amber: [255, 208, 90],
  green: [54, 255, 120],
  cyan: [119, 239, 255],
  blue: [76, 141, 255],
  white: [239, 255, 244],
};

const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

export function rgba([r, g, b]: Rgb, alpha = 1): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = clamp(amount, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function plot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: Rgb,
  alpha = 1,
  width = 1,
  height = 1,
): void {
  ctx.fillStyle = rgba(color, alpha);
  ctx.fillRect(Math.round(x), Math.round(y), width, height);
}

export function drawLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: Rgb,
  alpha = 0.92,
  width = 1,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = rgba(color, alpha);
  ctx.stroke();
  ctx.restore();
}

export function drawBrokenLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: Rgb,
  seed: number,
  density = 0.74,
  step = 3,
  alpha = 0.9,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.max(1, Math.hypot(dx, dy));
  const count = Math.max(1, Math.floor(length / step));

  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const x = x1 + dx * t;
    const y = y1 + dy * t;
    const jitter = hash2(i, seed, 2) - 0.5;

    if (hash2(i, seed, 5) < density) {
      plot(ctx, x + jitter, y - jitter, color, alpha, i % 3 === 0 ? 2 : 1, 1);
    }
  }
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: Rgb,
  size: number,
  align: CanvasTextAlign = "center",
): void {
  ctx.save();
  ctx.font = `800 ${size}px "IBM Plex Mono", Menlo, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = rgba(color, 0.96);
  ctx.fillText(text, Math.round(x), Math.round(y));
  ctx.restore();
}

export function drawDotCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: Rgb,
  seed: number,
  density = 0.84,
  alpha = 0.92,
): void {
  const steps = Math.max(18, Math.round(radius * 5));

  for (let i = 0; i < steps; i += 1) {
    if (hash2(i, seed, 9) > density) {
      continue;
    }

    const angle = (i / steps) * Math.PI * 2;
    plot(ctx, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, color, alpha);
  }
}

export function drawCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: Rgb,
  alpha = 0.86,
  width = 1,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(Math.round(x) + 0.5, Math.round(y) + 0.5, radius, 0, Math.PI * 2);
  ctx.lineWidth = width;
  ctx.strokeStyle = rgba(color, alpha);
  ctx.stroke();
  ctx.restore();
}

export function applyInstrumentDisplayResponse(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: InstrumentPalette,
  seed = 0,
): void {
  ctx.save();

  ctx.globalCompositeOperation = "multiply";
  for (let y = 0; y < height; y += 3) {
    ctx.fillStyle = rgba(palette.bgDark, y % 6 === 0 ? 0.2 : 0.08);
    ctx.fillRect(0, y, width, 1);
  }

  ctx.globalCompositeOperation = "screen";
  for (let y = 1; y < height; y += 5) {
    ctx.fillStyle = rgba(palette.cyan, 0.018);
    ctx.fillRect(0, y, width, 1);
  }

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const grain = hash2(x, y, seed + 400);
      if (grain > 0.975) {
        plot(ctx, x, y, palette.white, 0.07);
      } else if (grain < 0.018) {
        plot(ctx, x, y, palette.traceDim, 0.05);
      }
    }
  }

  ctx.globalCompositeOperation = "source-over";
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.48,
    Math.min(width, height) * 0.12,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.72,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, rgba(palette.bgDark, 0.46));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.restore();
}

export function applyInstrumentPostProcess(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: InstrumentPalette,
): void {
  const image = ctx.getImageData(0, 0, width, height);
  const { data } = image;

  for (let y = 0; y < height; y += 1) {
    const scan = y % 3 === 0 ? 0.78 : y % 3 === 1 ? 1 : 0.9;

    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const bayer = BAYER_4[(x & 3) + ((y & 3) * 4)] - 7.5;
      const noise = (hash2(x, y, 0) - 0.5) * 14;
      const threshold = 44 + bayer * 4 + noise;
      const backgroundNoise = hash2(x, y, 100);

      let color = mix(palette.bgDark, palette.bg, backgroundNoise * 0.65);

      if (max + (max - min) * 0.35 > threshold) {
        const intensity = clamp((max - 35) / 185, 0.35, 1);

        if (g > r * 1.08 && b > r * 1.08 && b > g * 0.82) {
          color = mix(palette.bg, palette.cyan, intensity);
        } else if (g > r * 1.08 && g > b * 1.02) {
          color = mix(palette.bg, palette.green, intensity);
        } else if (b > r * 0.85 && b > g * 0.92) {
          color = mix(palette.bg, palette.blue, intensity * 0.78);
        } else if (r > 185 && g > 110) {
          color = mix(palette.bg, palette.amber, intensity);
        } else if (r > 165 && g > 130 && b > 120) {
          color = mix(palette.bg, palette.white, intensity * 0.85);
        } else {
          color = mix(palette.bg, palette.trace, intensity);
        }
      }

      data[index] = Math.round(color[0] * scan);
      data[index + 1] = Math.round(color[1] * scan);
      data[index + 2] = Math.round(color[2] * scan);
      data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
}
