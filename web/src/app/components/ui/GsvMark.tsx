import "./GsvMark.css";

export type GsvMarkVariant = "white" | "master" | "favicon";

const SRC: Record<GsvMarkVariant, string> = {
  white: "/brand/gsv-mark-white.svg",
  master: "/brand/gsv-mark-master.svg",
  favicon: "/favicon.svg",
};

// Native pixel-grid aspect (width / height) of each variant's artwork.
const RATIO: Record<GsvMarkVariant, number> = {
  white: 13 / 17,
  master: 13 / 17,
  favicon: 1, // square void tile
};

export interface GsvMarkProps {
  /** Rendered height in px; width follows the mark's aspect ratio. */
  size?: number;
  variant?: GsvMarkVariant;
  /** Accessible label; when omitted the mark is decorative (aria-hidden). */
  title?: string;
}

/** GsvMark — the GSV ship brand glyph. A pixel-art SVG rendered as an image so
 *  its multi-tone palette is preserved (it is not a tintable monochrome mask).
 *  The `white` variant is used on dark chrome (rail), `master` is the full-color
 *  desktop mark, and `favicon` is the condensed glyph used for the browser icon. */
export function GsvMark({ size = 22, variant = "white", title }: GsvMarkProps) {
  return (
    <img
      class="gsv-mark"
      src={SRC[variant]}
      width={Math.round(size * RATIO[variant])}
      height={size}
      alt={title ?? ""}
      aria-hidden={title ? undefined : "true"}
      draggable={false}
    />
  );
}
