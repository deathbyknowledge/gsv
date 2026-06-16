import {
  GSV_INSTRUMENT_PALETTE,
  applyInstrumentPostProcess,
  clamp,
  drawBrokenLine,
  drawDotCircle,
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
type IconMask = {
  size: number;
  alpha: Uint8ClampedArray;
};

const ICON_MASK_SIZE = 48;
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

function iconPath(paths: string[]): Path2D {
  const combined = new Path2D();
  paths.forEach((path) => combined.addPath(new Path2D(path)));
  return combined;
}

function iconMask(icon: string, paths: string[]): IconMask {
  const cached = iconMaskCache.get(icon);
  if (cached) {
    return cached;
  }

  const layer = document.createElement("canvas");
  layer.width = ICON_MASK_SIZE;
  layer.height = ICON_MASK_SIZE;

  const layerCtx = layer.getContext("2d", { willReadFrequently: true });
  if (!layerCtx) {
    throw new Error("Unable to create system map icon mask");
  }

  layerCtx.fillStyle = "#fff";
  layerCtx.fill(iconPath(paths));

  const image = layerCtx.getImageData(0, 0, ICON_MASK_SIZE, ICON_MASK_SIZE);
  const alpha = new Uint8ClampedArray(ICON_MASK_SIZE * ICON_MASK_SIZE);

  for (let i = 0; i < alpha.length; i += 1) {
    alpha[i] = image.data[i * 4 + 3];
  }

  const mask = { size: ICON_MASK_SIZE, alpha };
  iconMaskCache.set(icon, mask);
  return mask;
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
    const left = x - size / 2;
    const top = y - size / 2;
    const unit = size / mask.size;

    for (let my = 1; my < mask.size - 1; my += 2) {
      let runStart = -1;

      for (let mx = 0; mx <= mask.size; mx += 1) {
        const inside = mx < mask.size && mask.alpha[my * mask.size + mx] > 16;

        if (inside && runStart === -1) {
          runStart = mx;
          continue;
        }

        if (!inside && runStart !== -1) {
          const runEnd = mx - 1;
          const runLength = runEnd - runStart;
          if (runLength > 1 && hash2(my, runStart + x, 13) > 0.18) {
            drawBrokenLine(
              ctx,
              left + runStart * unit,
              top + my * unit,
              left + runEnd * unit,
              top + my * unit,
              color,
              x + y + my,
              0.8,
              Math.max(1, Math.round(1.35 * scale)),
            );
          }
          runStart = -1;
        }
      }
    }

    for (let my = 0; my < mask.size; my += 3) {
      for (let mx = 0; mx < mask.size; mx += 3) {
        if (mask.alpha[my * mask.size + mx] <= 16 || hash2(mx + x, my + y, 17) < 0.68) {
          continue;
        }

        plot(
          ctx,
          left + mx * unit,
          top + my * unit,
          color,
          0.76,
          Math.max(1, Math.round(unit * 1.2)),
          1,
        );
      }
    }

    for (let i = 0; i < Math.round(size * 0.72); i += 1) {
      const mx = Math.floor(hash2(i, y, 19) * mask.size);
      const my = Math.floor(hash2(i, x, 23) * mask.size);
      if (mask.alpha[my * mask.size + mx] > 16 && hash2(mx, my, 29) > 0.42) {
        plot(ctx, left + mx * unit, top + my * unit, COLORS.bgDark, 0.88, 1, 1);
      }
    }

    const tearY = y + size * 0.28;
    drawBrokenLine(ctx, x - size * 0.38, tearY, x + size * 0.38, tearY, color, x + y, 0.5, 2);
    drawDotCircle(ctx, x, y, size * 0.45, color, x + y + 43, 0.32);
    return;
  }

  const s = scale * 1.25;
  drawDotCircle(ctx, x, y, 8 * s, color, x + y, 0.92);
  drawBrokenLine(ctx, x - 7 * s, y, x + 7 * s, y, color, x + y + 1, 0.9, 2);
  drawBrokenLine(ctx, x, y - 7 * s, x, y + 7 * s, color, x + y + 2, 0.9, 2);
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

function drawSurveyField(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
  ctx.fillStyle = rgba(COLORS.bg);
  ctx.fillRect(0, 0, width, height);

  const tileW = Math.max(76, Math.round(width / 5));
  const tileH = Math.max(54, Math.round(height / 4));

  for (let x = 0; x <= width; x += tileW) {
    ctx.fillStyle = rgba(COLORS.traceDim, 0.28);
    ctx.fillRect(x, 0, 1, height);
  }

  for (let y = 0; y <= height; y += tileH) {
    ctx.fillStyle = rgba(COLORS.traceDim, 0.3);
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
        plot(ctx, x, y, COLORS.blue, 0.16);
        continue;
      }

      if (Math.abs(ridge) < 0.1 && grain > 0.18) {
        plot(ctx, x, y, COLORS.traceDim, 0.24, grain > 0.92 ? 2 : 1, 1);
      } else if (ridge > 1.18 && grain > 0.52) {
        plot(ctx, x, y, COLORS.traceDim, 0.18);
      }
    }
  }

  for (let i = 0; i < 9; i += 1) {
    const x1 = (hash2(i, 1, 40) * width) - width * 0.1;
    const y1 = hash2(i, 2, 41) * height;
    const x2 = x1 + (hash2(i, 3, 42) - 0.2) * width * 0.58;
    const y2 = y1 + (hash2(i, 4, 43) - 0.5) * height * 0.38;
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.traceDim, i + Math.floor(time * 3), 0.22, 4);
  }

  for (let y = 34; y < height; y += 62) {
    for (let x = 42; x < width; x += 120) {
      plot(ctx, x - 3, y, COLORS.traceDim, 0.4, 7, 1);
      plot(ctx, x, y - 3, COLORS.traceDim, 0.4, 1, 7);
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
  links.forEach((link, index) => {
    const [x1, y1] = projectSystemMapPoint(link.from, width, height, camera);
    const [x2, y2] = projectSystemMapPoint(link.to, width, height, camera);
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.cyan, index + 90, 0.72, 3);
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.green, index + 95, 0.22, 6);
    drawBrokenLine(ctx, x1, y1, x2, y2, COLORS.white, index + 120, 0.16, 6);
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

    drawDotCircle(ctx, x, y, radius * pulse, color, index + 12, selected ? 0.96 : 0.82);
    drawDotCircle(ctx, x, y, radius * 0.58 * pulse, color, index + 24, selected ? 0.92 : 0.58);

    if (selected) {
      drawDotCircle(ctx, x, y, radius + 7, COLORS.amber, index + 31, 0.9);
      drawBrokenLine(ctx, x - radius - 12, y, x - radius - 3, y, COLORS.amber, index + 32, 0.95, 2);
      drawBrokenLine(ctx, x + radius + 3, y, x + radius + 12, y, COLORS.amber, index + 33, 0.95, 2);
    }

    drawGlyph(ctx, node, x, y, color, scale);

    const label = node.label.toUpperCase();
    drawText(ctx, label, x, y + radius + 13 * scale, color, (node.kind === "root" ? 11 : 8) * scale);

    if (node.note) {
      drawText(ctx, node.note.toUpperCase(), x + radius + 22 * scale, y - radius - 3 * scale, COLORS.white, 7 * scale, "left");
      drawBrokenLine(ctx, x + radius + 4 * scale, y - 5 * scale, x + radius + 20 * scale, y - radius - 3 * scale, COLORS.white, index + 60, 0.88, 2);
    }

    if (node.status) {
      const statusSize = Math.max(3, Math.round(3 * scale));
      plot(ctx, x + radius - 2 * scale, y - radius + 2 * scale, color, 0.95, statusSize, statusSize);
    }
  });
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
  drawSurveyField(layerCtx, width, height, 0);
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
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(backgroundImage(width, height), 0, 0);
  drawLinks(ctx, options.links, width, height, options.camera);
  drawNodes(ctx, options.nodes, options.selection, width, height, options.camera, options.time);
  drawHudRaster(ctx, width, height, options.selection);
  ctx.restore();
}
