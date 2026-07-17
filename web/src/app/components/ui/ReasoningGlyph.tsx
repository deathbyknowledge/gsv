/** Brain — the reasoning affordance (per-message meta icon and the activity
 *  line's expand-reasoning button). Drawn on the message-meta icon grid
 *  (16-viewBox, 1.4 stroke — the copy glyph's family) so it reads cleanly from
 *  13px (meta) up to 16px (activity line): two hemispheres, central sulcus,
 *  one fold per side. `detail` drops the folds if they muddy at small sizes. */

export interface ReasoningGlyphProps {
  /** Square size in px. */
  size?: number;
  /** Render the hemisphere folds (drop for very small sizes if muddy). */
  detail?: boolean;
}

export function ReasoningGlyph({ size = 16, detail = true }: ReasoningGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3.2 C7.3 1.8 4.9 1.9 4.3 3.4 C2.7 3.6 2.1 5.5 3.2 6.7 C2.3 7.9 2.9 9.7 4.3 10 C4.5 11.7 6.6 12.4 8 11.3" />
      <path d="M8 3.2 C8.7 1.8 11.1 1.9 11.7 3.4 C13.3 3.6 13.9 5.5 12.8 6.7 C13.7 7.9 13.1 9.7 11.7 10 C11.5 11.7 9.4 12.4 8 11.3" />
      <path d="M8 3.2 V11.3" />
      {detail ? <path d="M5.2 5.2 C6.1 5.6 6.1 6.5 5.4 7" /> : null}
      {detail ? <path d="M10.8 5.2 C9.9 5.6 9.9 6.5 10.6 7" /> : null}
    </svg>
  );
}
