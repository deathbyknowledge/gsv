import {
  GSV_INSTRUMENT_PALETTE,
  applyInstrumentDisplayResponse,
  applyInstrumentPostProcess,
  clamp,
  drawBrokenLine,
  drawCircle,
  drawDotCircle,
  drawLine,
  drawText,
  hash2,
  plot,
  rgba,
  type Rgb,
} from "../../rendering/instrumentRaster";

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

export type SystemMapCanvasCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type SystemMapCanvasOptions = {
  nodes: SystemMapCanvasNode[];
  links: SystemMapCanvasLink[];
  selection: string;
  camera: SystemMapCanvasCamera;
  time: number;
};

const COLORS = GSV_INSTRUMENT_PALETTE;

let backgroundCache: { key: string; image: ImageData } | null = null;
let foregroundLayer: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null = null;
type IconMask = {
  size: number;
  alpha: Uint8ClampedArray;
};

const ICON_MASK_SIZE = 96;
const iconMaskCache = new Map<string, IconMask>();
const ICON_PATHS: Record<string, string[]> = {
  ship: [
    "M24 4 16 14v17h16V14L24 4Zm-4 12h8v11h-8V16Z",
    "M13 28 5 37v7h13V31l-5-3Zm22 0-5 3v13h13v-7l-8-9ZM20 36h8v8h-8v-8Z",
  ],
  machine: [
    "M11 10c0-3 2-5 5-5h16c3 0 5 2 5 5v13H11V10Zm0 18h26v10H11V28Zm6 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm15 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  ],
  messenger: [
    "M10 8h28c3 0 5 2 5 5v17c0 3-2 5-5 5H24l-11 8v-8h-3c-3 0-5-2-5-5V13c0-3 2-5 5-5Z",
  ],
  integration: [
    "M18 31a9 9 0 0 1 0-13l5-5a9 9 0 0 1 13 13l-3 3-5-5 3-3a2 2 0 0 0-3-3l-5 5a2 2 0 0 0 0 3l1 1-5 5-1-1Z",
    "M12 35a9 9 0 0 1 0-13l3-3 5 5-3 3a2 2 0 0 0 3 3l5-5a2 2 0 0 0 0-3l-1-1 5-5 1 1a9 9 0 0 1 0 13l-5 5a9 9 0 0 1-13 0Z",
  ],
  plus: [
    "M20 6h8v14h14v8H28v14h-8V28H6v-8h14V6Z",
  ],
};

function iconMask(icon: string, paths: string[]): IconMask {
  const cached = iconMaskCache.get(icon);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = ICON_MASK_SIZE;
  canvas.height = ICON_MASK_SIZE;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Unable to create system map icon mask");
  }

  const combined = new Path2D();
  paths.forEach((path) => combined.addPath(new Path2D(path)));

  context.save();
  context.scale(ICON_MASK_SIZE / 48, ICON_MASK_SIZE / 48);
  context.fillStyle = "#fff";
  context.fill(combined);
  context.restore();

  const image = context.getImageData(0, 0, ICON_MASK_SIZE, ICON_MASK_SIZE);
  const alpha = new Uint8ClampedArray(ICON_MASK_SIZE * ICON_MASK_SIZE);

  for (let i = 0; i < alpha.length; i += 1) {
    alpha[i] = image.data[i * 4 + 3];
  }

  const mask = { size: ICON_MASK_SIZE, alpha };
  iconMaskCache.set(icon, mask);
  return mask;
}

function foregroundContext(width: number, height: number): CanvasRenderingContext2D {
  if (!foregroundLayer) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create system map foreground layer");
    }
    foregroundLayer = { canvas, context };
  }

  if (foregroundLayer.canvas.width !== width || foregroundLayer.canvas.height !== height) {
    foregroundLayer.canvas.width = width;
    foregroundLayer.canvas.height = height;
  }

  foregroundLayer.context.clearRect(0, 0, width, height);
  foregroundLayer.context.imageSmoothingEnabled = true;
  return foregroundLayer.context;
}

function drawingScale(width: number, height: number): number {
  return clamp(Math.min(width, height) / 520, 1, 1.55);
}

export function projectSystemMapPoint(
  node: Pick<SystemMapCanvasNode, "x" | "y">,
  width: number,
  height: number,
  camera: SystemMapCanvasCamera,
): [number, number] {
  return [
    Math.round((((node.x - camera.x) * camera.zoom + 50) / 100) * width),
    Math.round((((node.y - camera.y) * camera.zoom + 50) / 100) * height),
  ];
}

function maskAlpha(mask: IconMask, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= mask.size || y >= mask.size) {
    return 0;
  }

  return mask.alpha[(y * mask.size) + x] / 255;
}

function drawDitherGlyph(
  ctx: CanvasRenderingContext2D,
  mask: IconMask,
  x: number,
  y: number,
  size: number,
  color: Rgb,
  seed: number,
): void {
  const left = x - size / 2;
  const top = y - size / 2;
  const unit = size / mask.size;
  const phase = Math.abs(Math.floor(seed)) % 7;

  for (let my = 1; my < mask.size - 1; my += 2) {
    let runStart = -1;

    for (let mx = 0; mx <= mask.size; mx += 1) {
      const alpha = mx < mask.size ? maskAlpha(mask, mx, my) : 0;
      const ordered = ((mx + my * 2 + phase) % 6) < 4;
      const scan = my % 8 === 1 ? 0.68 : my % 4 === 1 ? 0.78 : 0.9;
      const inside = alpha > 0.34 && (alpha > 0.78 || ordered);

      if (inside && runStart === -1) {
        runStart = mx;
        continue;
      }

      if (!inside && runStart !== -1) {
        const runEnd = mx - 1;
        plot(
          ctx,
          left + runStart * unit,
          top + my * unit,
          color,
          0.48 * scan,
          Math.max(1, Math.round((runEnd - runStart + 1) * unit)),
          Math.max(1, unit * 1.1),
        );
        runStart = -1;
      }
    }
  }

  for (let my = 1; my < mask.size - 1; my += 4) {
    for (let mx = 1; mx < mask.size - 1; mx += 4) {
      const alpha = maskAlpha(mask, mx, my);
      if (alpha < 0.5 || ((mx * 3 + my + phase) % 8) > 2) {
        continue;
      }

      plot(ctx, left + mx * unit, top + my * unit, COLORS.white, 0.08, Math.max(1, unit * 1.6), 1);
    }
  }
}

function drawInstrumentTrace(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: Rgb,
  seed: number,
  scale: number,
): void {
  drawLine(ctx, x1, y1, x2, y2, color, 0.2, Math.max(1, 0.75 * scale));
  drawBrokenLine(ctx, x1, y1, x2, y2, color, seed, 0.94, Math.max(2, Math.round(2 * scale)), 0.34);
  drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.green, seed + 7, 0.28, Math.max(4, Math.round(4 * scale)), 0.12);
  drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.white, seed + 11, 0.18, Math.max(5, Math.round(5 * scale)), 0.1);
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  node: SystemMapCanvasNode,
  x: number,
  y: number,
  color: Rgb,
  scale: number,
): void {
  const paths = ICON_PATHS[node.icon];

  if (paths) {
    const size = (node.kind === "root" ? 40 : node.kind === "category" ? 34 : 28) * scale;
    const mask = iconMask(node.icon, paths);

    drawDitherGlyph(ctx, mask, x, y, size, color, x + y);
    drawDotCircle(ctx, x, y, size * 0.47, color, x + y + 43, 0.18, 0.38);
    return;
  }

  const s = scale * 1.25;
  drawCircle(ctx, x, y, 8 * s, color, 0.7, 1.2 * scale);
  drawLine(ctx, x - 7 * s, y, x + 7 * s, y, color, 0.86, 1.4 * scale);
  drawLine(ctx, x, y - 7 * s, x, y + 7 * s, color, 0.86, 1.4 * scale);
}

function statusColor(node: SystemMapCanvasNode): Rgb {
  if (node.status === "online") {
    return COLORS.green;
  }

  if (node.status === "offline") {
    return COLORS.alert;
  }

  if (node.status === "warning") {
    return COLORS.amber;
  }

  if (node.status === "busy") {
    return COLORS.blue;
  }

  return node.kind === "category" ? COLORS.cyan : COLORS.green;
}

function drawDitherArc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  start: number,
  end: number,
  color: Rgb,
  seed: number,
): void {
  const steps = 96;
  let previous: [number, number] | null = null;

  for (let i = 0; i <= steps; i += 1) {
    const t = start + ((end - start) * i) / steps;
    const x = cx + Math.cos(t) * rx;
    const y = cy + Math.sin(t) * ry;

    if (previous && hash2(i, seed, 63) > 0.12) {
      drawBrokenLine(ctx, previous[0], previous[1], x, y, color, seed + i, 0.34, 5, 0.18);
    }

    previous = [x, y];
  }
}

function drawStarChartField(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
  ctx.fillStyle = rgba(COLORS.bg);
  ctx.fillRect(0, 0, width, height);

  const tileW = Math.max(92, Math.round(width / 6));
  const tileH = Math.max(72, Math.round(height / 5));

  for (let x = 0; x <= width; x += tileW) {
    ctx.fillStyle = rgba(COLORS.traceDim, 0.18);
    ctx.fillRect(x, 0, 1, height);
  }

  for (let y = 0; y <= height; y += tileH) {
    ctx.fillStyle = rgba(COLORS.traceDim, 0.16);
    ctx.fillRect(0, y, width, 1);
  }

  const clouds = [
    { x: 0.2, y: 0.28, rx: 0.2, ry: 0.16, color: COLORS.blue, seed: 4 },
    { x: 0.68, y: 0.18, rx: 0.18, ry: 0.12, color: COLORS.traceDim, seed: 9 },
    { x: 0.76, y: 0.72, rx: 0.22, ry: 0.18, color: COLORS.cyan, seed: 15 },
  ];

  for (let y = 1; y < height; y += 3) {
    for (let x = 1; x < width; x += 3) {
      const nx = x / width;
      const ny = y / height;
      const grain = hash2(x, y, 11);

      clouds.forEach((cloud) => {
        const dx = (nx - cloud.x) / cloud.rx;
        const dy = (ny - cloud.y) / cloud.ry;
        const falloff = Math.max(0, 1 - dx * dx - dy * dy);

        if (falloff > 0 && grain > 1 - falloff * 0.18) {
          const alpha = 0.06 + falloff * 0.1;
          plot(ctx, x, y, cloud.color, alpha, grain > 0.98 ? 2 : 1, 1);
        }
      });

      if (grain > 0.994) {
        plot(ctx, x, y, COLORS.white, 0.5, 1, 1);
      } else if (grain > 0.986) {
        plot(ctx, x, y, COLORS.cyan, 0.2, 1, 1);
      } else if (grain > 0.974) {
        plot(ctx, x, y, COLORS.traceDim, 0.18, 1, 1);
      }
    }
  }

  for (let i = 0; i < 7; i += 1) {
    const x1 = hash2(i, 1, 40) * width;
    const y1 = hash2(i, 2, 41) * height;
    const x2 = x1 + (hash2(i, 3, 42) - 0.5) * width * 0.34;
    const y2 = y1 + (hash2(i, 4, 43) - 0.5) * height * 0.24;
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.traceDim, i + Math.floor(time * 3), 0.18, 6, 0.18);
  }

  drawDitherArc(ctx, width * 0.43, height * 0.46, width * 0.34, height * 0.2, -0.2, Math.PI * 1.1, COLORS.traceDim, 80);
  drawDitherArc(ctx, width * 0.62, height * 0.6, width * 0.24, height * 0.32, Math.PI * 0.9, Math.PI * 1.92, COLORS.blue, 94);

  for (let y = 36; y < height; y += 78) {
    for (let x = 44; x < width; x += 128) {
      const alpha = hash2(x, y, 72) > 0.28 ? 0.34 : 0.14;
      plot(ctx, x - 3, y, COLORS.traceDim, alpha, 7, 1);
      plot(ctx, x, y - 3, COLORS.traceDim, alpha, 1, 7);
    }
  }
}

function drawLinks(
  ctx: CanvasRenderingContext2D,
  links: SystemMapCanvasLink[],
  width: number,
  height: number,
  camera: SystemMapCanvasCamera,
): void {
  const scale = drawingScale(width, height);

  links.forEach((link, index) => {
    const [x1, y1] = projectSystemMapPoint(link.from, width, height, camera);
    const [x2, y2] = projectSystemMapPoint(link.to, width, height, camera);
    drawInstrumentTrace(ctx, x1, y1, x2, y2, COLORS.cyan, index + 90, scale);
  });
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: SystemMapCanvasNode[],
  selection: string,
  width: number,
  height: number,
  camera: SystemMapCanvasCamera,
  time: number,
): void {
  const scale = drawingScale(width, height);

  nodes.forEach((node, index) => {
    const [x, y] = projectSystemMapPoint(node, width, height, camera);
    const selected = node.id === selection;
    const color = statusColor(node);
    const pulse = selected ? 1 + Math.sin(time * 4) * 0.04 : 1;
    const radius = (node.kind === "root" ? 20 : node.kind === "category" ? 16 : 12) * scale;

    drawCircle(ctx, x, y, radius * pulse, color, selected ? 0.88 : 0.58, Math.max(1, 1.2 * scale));
    drawCircle(ctx, x, y, radius * 0.58 * pulse, color, selected ? 0.68 : 0.34, Math.max(1, 0.8 * scale));
    drawDotCircle(ctx, x, y, radius * pulse, color, index + 12, selected ? 0.72 : 0.44, 0.32);

    if (selected) {
      drawCircle(ctx, x, y, radius + 7, COLORS.amber, 0.82, Math.max(1, 1.2 * scale));
      drawLine(ctx, x - radius - 12, y, x - radius - 3, y, COLORS.amber, 0.78, Math.max(1, 1.1 * scale));
      drawLine(ctx, x + radius + 3, y, x + radius + 12, y, COLORS.amber, 0.78, Math.max(1, 1.1 * scale));
    }

    drawGlyph(ctx, node, x, y, color, scale);

    const label = node.label.toUpperCase();
    drawText(ctx, label, x, y + radius + 13 * scale, color, (node.kind === "root" ? 11 : 8) * scale);

    if (node.note) {
      drawText(ctx, node.note.toUpperCase(), x + radius + 22 * scale, y - radius - 3 * scale, COLORS.white, 7 * scale, "left");
      drawLine(ctx, x + radius + 4 * scale, y - 5 * scale, x + radius + 20 * scale, y - radius - 3 * scale, COLORS.white, 0.58, Math.max(1, 1 * scale));
    }

    if (node.status) {
      const statusSize = Math.max(3, Math.round(3 * scale));
      plot(ctx, x + radius - 2 * scale, y - radius + 2 * scale, color, 0.95, statusSize, statusSize);
    }
  });
}

function drawForeground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: SystemMapCanvasOptions,
): void {
  drawLinks(ctx, options.links, width, height, options.camera);
  drawNodes(ctx, options.nodes, options.selection, width, height, options.camera, options.time);
  drawHudRaster(ctx, width, height, options.selection);
}

function drawEmission(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement): void {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.5;
  ctx.filter = "blur(1.4px)";
  ctx.drawImage(layer, 0, 0);
  ctx.globalAlpha = 0.22;
  ctx.filter = "blur(4px)";
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

function drawHudRaster(ctx: CanvasRenderingContext2D, width: number, height: number, selection: string): void {
  const scale = drawingScale(width, height);

  drawText(ctx, "GSV SYSTEM MAP", 15 * scale, 16 * scale, COLORS.green, 8 * scale, "left");
  drawText(ctx, selection === "overview" ? "SYSTEM" : selection.toUpperCase(), 15 * scale, 31 * scale, COLORS.cyan, 11 * scale, "left");
  drawText(ctx, "MICROFORM LINK 07", width - 14 * scale, 16 * scale, COLORS.green, 7 * scale, "right");
  drawText(ctx, "NATIVE RUNTIME", width - 14 * scale, 28 * scale, COLORS.traceDim, 7 * scale, "right");
}

function backgroundImage(width: number, height: number): ImageData {
  const key = `${width}x${height}`;

  if (backgroundCache?.key === key) {
    return backgroundCache.image;
  }

  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;

  const layerCtx = layer.getContext("2d", { willReadFrequently: true });
  if (!layerCtx) {
    throw new Error("Unable to create system map background layer");
  }

  layerCtx.imageSmoothingEnabled = false;
  drawStarChartField(layerCtx, width, height, 0);
  applyInstrumentPostProcess(layerCtx, width, height, COLORS);

  backgroundCache = {
    key,
    image: layerCtx.getImageData(0, 0, width, height),
  };

  return backgroundCache.image;
}

export function renderSystemMapCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: SystemMapCanvasOptions,
): void {
  const foreground = foregroundContext(width, height);
  drawForeground(foreground, width, height, options);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.putImageData(backgroundImage(width, height), 0, 0);
  drawEmission(ctx, foreground.canvas);
  ctx.drawImage(foreground.canvas, 0, 0);
  applyInstrumentDisplayResponse(ctx, width, height, COLORS, Math.floor(options.time * 60));
  ctx.restore();
}
