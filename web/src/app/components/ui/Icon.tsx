import "./Icon.css";

export interface IconProps {
  /** Icon name = filename in web/public/icons/ without extension
   *  (e.g. "folder", "cog", "terminal", "pencil"). */
  name: string;
  /** Square size in px. */
  size?: number;
  /** Tint color; defaults to inherited `currentColor`. */
  color?: string;
  title?: string;
}

/** Icon — masks a static SVG so it takes a theme color via CSS. */
export function Icon({ name, size = 18, color, title }: IconProps) {
  const url = `url(/icons/${name}.svg)`;
  return (
    <span
      class="gsv-icon"
      role="img"
      aria-label={title ?? name}
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
