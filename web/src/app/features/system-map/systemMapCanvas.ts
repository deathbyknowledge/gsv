export type SystemMapCanvasNodeKind = "root" | "category" | "object" | "app";
export type SystemMapCanvasStatus = "online" | "offline" | "warning" | "busy" | "neutral";

export type SystemMapCanvasNode = {
  id: string;
  label: string;
  kind: SystemMapCanvasNodeKind;
  icon: string;
  x: number;
  y: number;
  status?: SystemMapCanvasStatus;
  note?: string;
};

export type SystemMapCanvasLink = {
  id: string;
  from: Pick<SystemMapCanvasNode, "x" | "y">;
  to: Pick<SystemMapCanvasNode, "x" | "y">;
};

export type SystemMapCanvasOptions = {
  nodes: SystemMapCanvasNode[];
  links: SystemMapCanvasLink[];
  selection: string;
  time: number;
};

type Rgb = [number, number, number];

const COLORS = {
  bg: [34, 13, 17] as Rgb,
  bgDark: [16, 8, 12] as Rgb,
  grid: [76, 24, 22] as Rgb,
  redDim: [112, 35, 25] as Rgb,
  red: [221, 59, 27] as Rgb,
  orange: [255, 82, 31] as Rgb,
  amber: [244, 179, 20] as Rgb,
  green: [58, 224, 83] as Rgb,
  blue: [27, 92, 126] as Rgb,
  white: [224, 207, 199] as Rgb,
};

const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function rgba([r, g, b]: Rgb, alpha = 1): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = clamp(amount, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function plot(
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

function point(node: Pick<SystemMapCanvasNode, "x" | "y">, width: number, height: number): [number, number] {
  return [
    Math.round((node.x / 100) * width),
    Math.round((node.y / 100) * height),
  ];
}

function drawBrokenLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: Rgb,
  seed: number,
  density = 0.74,
  step = 3,
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
      plot(ctx, x + jitter, y - jitter, color, 0.9, i % 3 === 0 ? 2 : 1, 1);
    }
  }
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: Rgb,
  size: number,
  align: CanvasTextAlign = "center",
): void {
  ctx.save();
  ctx.font = `700 ${size}px "IBM Plex Mono", Menlo, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = rgba(color, 0.95);
  ctx.fillText(text, Math.round(x), Math.round(y));
  ctx.restore();
}

function drawDotCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: Rgb,
  seed: number,
  density = 0.84,
): void {
  const steps = Math.max(18, Math.round(radius * 5));

  for (let i = 0; i < steps; i += 1) {
    if (hash2(i, seed, 9) > density) {
      continue;
    }

    const angle = (i / steps) * Math.PI * 2;
    plot(ctx, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, color, 0.92);
  }
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  node: SystemMapCanvasNode,
  x: number,
  y: number,
  color: Rgb,
): void {
  if (node.icon === "machine") {
    drawBrokenLine(ctx, x - 7, y - 7, x + 7, y - 7, color, x + y, 0.9, 2);
    drawBrokenLine(ctx, x - 7, y - 7, x - 7, y + 7, color, x + y + 2, 0.9, 2);
    drawBrokenLine(ctx, x + 7, y - 7, x + 7, y + 7, color, x + y + 3, 0.9, 2);
    drawBrokenLine(ctx, x - 7, y + 7, x + 7, y + 7, color, x + y + 4, 0.9, 2);
    plot(ctx, x - 4, y + 3, color, 0.9, 2, 2);
    plot(ctx, x + 4, y + 3, color, 0.9, 2, 2);
    return;
  }

  if (node.icon === "messenger") {
    drawBrokenLine(ctx, x - 8, y - 6, x + 8, y - 6, color, x + y, 0.9, 2);
    drawBrokenLine(ctx, x - 8, y - 6, x - 8, y + 5, color, x + y + 1, 0.9, 2);
    drawBrokenLine(ctx, x + 8, y - 6, x + 8, y + 5, color, x + y + 2, 0.9, 2);
    drawBrokenLine(ctx, x - 8, y + 5, x + 3, y + 5, color, x + y + 3, 0.9, 2);
    drawBrokenLine(ctx, x + 3, y + 5, x - 4, y + 11, color, x + y + 4, 0.9, 2);
    return;
  }

  if (node.icon === "integration") {
    drawDotCircle(ctx, x - 5, y, 6, color, x + y, 0.92);
    drawDotCircle(ctx, x + 5, y, 6, color, x + y + 1, 0.92);
    drawBrokenLine(ctx, x - 2, y, x + 2, y, color, x + y + 2, 0.95, 2);
    return;
  }

  if (node.icon === "plus") {
    drawBrokenLine(ctx, x - 8, y, x + 8, y, color, x + y, 0.95, 2);
    drawBrokenLine(ctx, x, y - 8, x, y + 8, color, x + y + 1, 0.95, 2);
    return;
  }

  if (node.icon === "ship") {
    drawBrokenLine(ctx, x, y - 14, x - 8, y + 9, color, x + y, 0.96, 2);
    drawBrokenLine(ctx, x, y - 14, x + 8, y + 9, color, x + y + 1, 0.96, 2);
    drawBrokenLine(ctx, x - 8, y + 9, x + 8, y + 9, color, x + y + 2, 0.96, 2);
    drawBrokenLine(ctx, x - 3, y - 2, x + 3, y - 2, color, x + y + 3, 0.95, 2);
    drawBrokenLine(ctx, x - 11, y + 7, x - 16, y + 15, color, x + y + 4, 0.9, 2);
    drawBrokenLine(ctx, x + 11, y + 7, x + 16, y + 15, color, x + y + 5, 0.9, 2);
    return;
  }

  drawDotCircle(ctx, x, y, 8, color, x + y, 0.92);
  drawBrokenLine(ctx, x - 7, y, x + 7, y, color, x + y + 1, 0.9, 2);
  drawBrokenLine(ctx, x, y - 7, x, y + 7, color, x + y + 2, 0.9, 2);
}

function statusColor(node: SystemMapCanvasNode): Rgb {
  if (node.status === "online") {
    return COLORS.green;
  }

  if (node.status === "offline") {
    return COLORS.red;
  }

  if (node.status === "warning") {
    return COLORS.amber;
  }

  if (node.status === "busy") {
    return COLORS.blue;
  }

  return node.kind === "category" ? COLORS.orange : COLORS.red;
}

function drawSurveyField(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
  ctx.fillStyle = rgba(COLORS.bg);
  ctx.fillRect(0, 0, width, height);

  const tileW = Math.max(76, Math.round(width / 5));
  const tileH = Math.max(54, Math.round(height / 4));

  for (let x = 0; x <= width; x += tileW) {
    ctx.fillStyle = rgba(COLORS.grid, 0.4);
    ctx.fillRect(x, 0, 1, height);
  }

  for (let y = 0; y <= height; y += tileH) {
    ctx.fillStyle = rgba(COLORS.grid, 0.42);
    ctx.fillRect(0, y, width, 1);
  }

  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const nx = x / width;
      const ny = y / height;
      const ridge =
        Math.sin(nx * 24 + ny * 7.5 + 0.2) +
        Math.sin(nx * 8.5 - ny * 19) +
        Math.sin((nx + ny) * 31);
      const water = x > width * (0.58 + Math.sin(ny * 9) * 0.06);
      const grain = hash2(x, y, 11);

      if (water && grain > 0.44) {
        plot(ctx, x, y, COLORS.blue, 0.42);
        continue;
      }

      if (Math.abs(ridge) < 0.1 && grain > 0.18) {
        plot(ctx, x, y, COLORS.redDim, 0.72, grain > 0.92 ? 2 : 1, 1);
      } else if (ridge > 1.18 && grain > 0.52) {
        plot(ctx, x, y, COLORS.redDim, 0.55);
      }
    }
  }

  for (let i = 0; i < 9; i += 1) {
    const x1 = (hash2(i, 1, 40) * width) - width * 0.1;
    const y1 = hash2(i, 2, 41) * height;
    const x2 = x1 + (hash2(i, 3, 42) - 0.2) * width * 0.58;
    const y2 = y1 + (hash2(i, 4, 43) - 0.5) * height * 0.38;
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.redDim, i + Math.floor(time * 3), 0.5, 3);
  }

  for (let y = 34; y < height; y += 62) {
    for (let x = 42; x < width; x += 120) {
      plot(ctx, x - 3, y, COLORS.redDim, 0.65, 7, 1);
      plot(ctx, x, y - 3, COLORS.redDim, 0.65, 1, 7);
    }
  }
}

function drawLinks(
  ctx: CanvasRenderingContext2D,
  links: SystemMapCanvasLink[],
  width: number,
  height: number,
): void {
  links.forEach((link, index) => {
    const [x1, y1] = point(link.from, width, height);
    const [x2, y2] = point(link.to, width, height);
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.orange, index + 90, 0.78, 3);
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.white, index + 120, 0.16, 6);
  });
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: SystemMapCanvasNode[],
  selection: string,
  width: number,
  height: number,
  time: number,
): void {
  nodes.forEach((node, index) => {
    const [x, y] = point(node, width, height);
    const selected = node.id === selection;
    const color = statusColor(node);
    const pulse = selected ? 1 + Math.sin(time * 4) * 0.08 : 1;
    const radius = node.kind === "root" ? 20 : node.kind === "category" ? 16 : 12;

    drawDotCircle(ctx, x, y, radius * pulse, color, index + 12, selected ? 0.96 : 0.82);
    drawDotCircle(ctx, x, y, radius * 0.58 * pulse, color, index + 24, selected ? 0.92 : 0.58);

    if (selected) {
      drawDotCircle(ctx, x, y, radius + 7, COLORS.amber, index + 31, 0.9);
      drawBrokenLine(ctx, x - radius - 12, y, x - radius - 3, y, COLORS.amber, index + 32, 0.95, 2);
      drawBrokenLine(ctx, x + radius + 3, y, x + radius + 12, y, COLORS.amber, index + 33, 0.95, 2);
    }

    drawGlyph(ctx, node, x, y, color);

    const label = node.label.toUpperCase();
    drawText(ctx, label, x, y + radius + 13, color, node.kind === "root" ? 11 : 8);

    if (node.note) {
      drawText(ctx, node.note.toUpperCase(), x + radius + 22, y - radius - 3, COLORS.white, 7, "left");
      drawBrokenLine(ctx, x + radius + 4, y - 5, x + radius + 20, y - radius - 3, COLORS.white, index + 60, 0.88, 2);
    }

    if (node.status) {
      plot(ctx, x + radius - 2, y - radius + 2, color, 0.95, 3, 3);
    }
  });
}

function drawHudRaster(ctx: CanvasRenderingContext2D, width: number, height: number, selection: string): void {
  drawText(ctx, "GSV SYSTEM MAP", 15, 16, COLORS.orange, 8, "left");
  drawText(ctx, selection === "overview" ? "SYSTEM" : selection.toUpperCase(), 15, 29, COLORS.amber, 11, "left");
  drawText(ctx, "MICROFORM LINK 07", width - 14, 16, COLORS.red, 7, "right");
  drawText(ctx, "NATIVE RUNTIME", width - 14, 28, COLORS.redDim, 7, "right");
}

function applyMicrofichePostProcess(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
  const image = ctx.getImageData(0, 0, width, height);
  const { data } = image;
  const flicker = Math.sin(time * 13) * 5;

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
      const noise = (hash2(x, y, Math.floor(time * 9)) - 0.5) * 26;
      const threshold = 54 + bayer * 5 + noise + flicker;
      const backgroundNoise = hash2(x, y, 100);

      let color = mix(COLORS.bgDark, COLORS.bg, backgroundNoise * 0.65);

      if (max + (max - min) * 0.35 > threshold) {
        const intensity = clamp((max - 35) / 185, 0.35, 1);

        if (g > r * 1.08 && g > b * 1.12) {
          color = mix(COLORS.bg, COLORS.green, intensity);
        } else if (b > r * 0.85 && b > g * 0.92) {
          color = mix(COLORS.bg, COLORS.blue, intensity * 0.78);
        } else if (r > 185 && g > 110) {
          color = mix(COLORS.bg, COLORS.amber, intensity);
        } else if (r > 165 && g > 130 && b > 120) {
          color = mix(COLORS.bg, COLORS.white, intensity * 0.85);
        } else {
          color = mix(COLORS.bg, COLORS.orange, intensity);
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

export function renderSystemMapCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: SystemMapCanvasOptions,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  drawSurveyField(ctx, width, height, options.time);
  drawLinks(ctx, options.links, width, height);
  drawNodes(ctx, options.nodes, options.selection, width, height, options.time);
  drawHudRaster(ctx, width, height, options.selection);
  applyMicrofichePostProcess(ctx, width, height, options.time);
  ctx.restore();
}
