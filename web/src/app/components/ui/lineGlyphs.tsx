/** Line glyphs — crisp, single-stroke outline icons drawn inline (not masked
 *  files, not doticons) so they stay sharp at small sizes and take a theme color
 *  via `currentColor`. Match the clear outline style of the IconButton glyph set.
 *  Rendered at an explicit pixel size for inline use inside bespoke buttons. */

export interface LineGlyphProps {
  /** Square size in px. */
  size?: number;
}

/** Speaker with sound waves — spoken replies enabled. */
export function SpeakerOnGlyph({ size = 16 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 L6 9 H2 V15 H6 L11 19 Z" />
      <path d="M15.54 8.46 a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93 a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

/** Muted speaker (× where the waves would be) — spoken replies disabled. */
export function SpeakerOffGlyph({ size = 16 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 L6 9 H2 V15 H6 L11 19 Z" />
      <path d="M22.5 9.5 L16.5 15.5 M16.5 9.5 L22.5 15.5" />
    </svg>
  );
}

/** Folder — the archive of older message segments. */
export function ArchiveFolderGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19 a2 2 0 0 1-2 2 H4 a2 2 0 0 1-2-2 V5 a2 2 0 0 1 2-2 h5 l2 3 h9 a2 2 0 0 1 2 2 Z" />
    </svg>
  );
}

/** Chevrons collapsing toward a centre line — compact ("free") the context. */
export function FreeContextGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 5 L12 9 L17 5" />
      <path d="M7 19 L12 15 L17 19" />
      <path d="M4.5 12 H19.5" />
    </svg>
  );
}

/** Plus — start a new task. Solid-stroke twin of the masked "plus" doticon,
 *  which reads dimmer than the label at popover sizes. */
export function PlusGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5 V19" />
      <path d="M5 12 H19" />
    </svg>
  );
}

/** Bulleted list — the open-tasks overview. */
export function TaskListGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 6 H20" />
      <path d="M9 12 H20" />
      <path d="M9 18 H20" />
      <path d="M4 6 H4.01" />
      <path d="M4 12 H4.01" />
      <path d="M4 18 H4.01" />
    </svg>
  );
}
