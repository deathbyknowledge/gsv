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

export type SystemMapCanvasOptions = {
  nodes: SystemMapCanvasNode[];
  links: SystemMapCanvasLink[];
  selection: string;
  time: number;
};

const COLORS = GSV_INSTRUMENT_PALETTE;

let backgroundCache: { key: string; image: ImageData } | null = null;

function drawingScale(width: number, height: number): number {
  return clamp(Math.min(width, height) / 520, 1, 1.55);
}

function point(node: Pick<SystemMapCanvasNode, "x" | "y">, width: number, height: number): [number, number] {
  return [
    Math.round((node.x / 100) * width),
    Math.round((node.y / 100) * height),
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
  const s = scale * 1.25;
  const unit = Math.max(2, Math.round(2 * scale));

  const rect = (left: number, top: number, width: number, height: number, alpha = 0.92): void => {
    plot(ctx, x + left * s, y + top * s, color, alpha, Math.max(unit, Math.round(width * s)), Math.max(unit, Math.round(height * s)));
  };

  if (node.icon === "machine") {
    rect(-8, -9, 16, 10);
    rect(-9, 3, 18, 7);
    rect(-5, 5, 3, 3, 0.98);
    rect(3, 5, 3, 3, 0.98);
    drawBrokenLine(ctx, x - 9 * s, y + 1 * s, x + 9 * s, y + 1 * s, color, x + y, 0.72, 2);
    return;
  }

  if (node.icon === "messenger") {
    rect(-10, -8, 20, 13);
    rect(-6, 4, 8, 5);
    rect(-7, -4, 3, 3, 0.98);
    rect(-1, -4, 3, 3, 0.98);
    rect(5, -4, 3, 3, 0.98);
    return;
  }

  if (node.icon === "integration") {
    drawDotCircle(ctx, x - 6 * s, y, 6 * s, color, x + y, 0.96);
    drawDotCircle(ctx, x + 6 * s, y, 6 * s, color, x + y + 1, 0.96);
    drawBrokenLine(ctx, x - 2 * s, y, x + 2 * s, y, color, x + y + 2, 0.98, 2);
    return;
  }

  if (node.icon === "plus") {
    drawBrokenLine(ctx, x - 8 * s, y, x + 8 * s, y, color, x + y, 0.95, 2);
    drawBrokenLine(ctx, x, y - 8 * s, x, y + 8 * s, color, x + y + 1, 0.95, 2);
    return;
  }

  if (node.icon === "ship") {
    rect(-4, -14, 8, 21);
    rect(-8, 4, 16, 7);
    rect(-14, 9, 7, 8);
    rect(7, 9, 7, 8);
    rect(-2, -8, 4, 5, 0.98);
    drawBrokenLine(ctx, x - 14 * s, y + 18 * s, x + 14 * s, y + 18 * s, color, x + y, 0.68, 2);
    return;
  }

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
): void {
  links.forEach((link, index) => {
    const [x1, y1] = point(link.from, width, height);
    const [x2, y2] = point(link.to, width, height);
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
  time: number,
): void {
  const scale = drawingScale(width, height);

  nodes.forEach((node, index) => {
    const [x, y] = point(node, width, height);
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
  drawLinks(ctx, options.links, width, height);
  drawNodes(ctx, options.nodes, options.selection, width, height, options.time);
  drawHudRaster(ctx, width, height, options.selection);
  ctx.restore();
}
