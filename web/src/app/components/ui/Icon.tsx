import "./Icon.css";

export type IconFamily = "doticons" | "gsv";
export type DotIconMatrix = 16 | 32 | "auto";

export interface IconProps {
  /** Icon name without extension. Defaults to the GSV icon set. */
  name: string;
  /** Square size in px. */
  size?: number;
  /** Tint color; defaults to inherited `currentColor`. */
  color?: string;
  family?: IconFamily;
  dotMatrix?: DotIconMatrix;
  title?: string;
}

const DOTICON_ALIAS: Record<string, string> = {
  add: "circlePlus",
  applications: "stars",
  computer: "box",
  files: "folder",
  integrations: "weblink",
  library: "pencil",
  machine: "box",
  machines: "box",
  messengers: "chat",
  plus: "circlePlus",
  settings: "cog",
  terminal: "powershell",
  whatsapp: "messenger",
};

const DOTICON_16_MISSING = new Set(["circleEuro", "preetier", "star", "watch", "wifi"]);

function cleanIconName(name: string): string {
  return name.replace(/^\/?icons\//, "").replace(/\.svg$/, "");
}

function isDoticonName(name: string): boolean {
  return cleanIconName(name).startsWith("doticons/");
}

function doticonName(name: string): string {
  const cleanName = cleanIconName(name).replace(/^doticons\/(?:16\/)?/, "");
  return DOTICON_ALIAS[cleanName] ?? cleanName;
}

function doticonMatrix(name: string, size: number, matrix: DotIconMatrix): 16 | 32 {
  if (matrix === 16 && !DOTICON_16_MISSING.has(name)) {
    return 16;
  }
  if (matrix === 32 || matrix === 16) {
    return 32;
  }
  return size <= 20 && !DOTICON_16_MISSING.has(name) ? 16 : 32;
}

function iconUrl(name: string, family: IconFamily, size: number, dotMatrix: DotIconMatrix): string {
  if (family === "gsv" && !isDoticonName(name)) {
    return `/icons/${cleanIconName(name)}.svg`;
  }
  const resolvedName = doticonName(name);
  const matrix = doticonMatrix(resolvedName, size, dotMatrix);
  return matrix === 16
    ? `/icons/doticons/16/${resolvedName}.svg`
    : `/icons/doticons/${resolvedName}.svg`;
}

/** Icon — masks a static SVG so it takes a theme color via CSS. */
export function Icon({ name, size = 18, color, family = "gsv", dotMatrix = "auto", title }: IconProps) {
  const resolvedName = family === "doticons" || isDoticonName(name) ? doticonName(name) : cleanIconName(name);
  const url = `url(${iconUrl(name, family, size, dotMatrix)})`;
  return (
    <span
      class="gsv-icon"
      role="img"
      aria-label={title ?? resolvedName}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        backgroundColor: color ?? "currentColor",
        WebkitMaskImage: url,
        maskImage: url,
      }}
    />
  );
}
