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

/** Geometry for the plus/minus pair. The bars are filled rects on whole-pixel
 *  coordinates rather than strokes: a stroke is centred on its path, so a 1px
 *  bar in a 24-unit viewBox always lands half on one pixel and half on the
 *  next, and the renderer either blurs it or snaps it a whole pixel off centre
 *  — which is what made the plus read as a lopsided cross. Both the box and the
 *  bar are odd, so the same number of pixels sits on either side of the bar and
 *  the arms are equal by construction. */
function barGeometry(size: number) {
  const box = Math.max(5, Math.round(size) | 1);
  // A hairline at the sizes these buttons use, thicker only once the glyph is
  // big enough that 1px would look starved. Even thicknesses are out: they
  // cannot centre in an odd box.
  const bar = box >= 21 ? 3 : 1;
  // Inset two pixels on every side: full-bleed arms made the plus read larger
  // than TaskListGlyph beside it, whose rules and bullets sit well inside their
  // own box. Symmetric, so the centring holds.
  return { box, bar, offset: (box - bar) / 2, inset: 2, length: box - 4 };
}

/** Plus — start a new task. Solid twin of the masked "plus" doticon, which
 *  reads dimmer than the label at popover sizes. */
export function PlusGlyph({ size = 14 }: LineGlyphProps) {
  const { box, bar, offset, inset, length } = barGeometry(size);
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="currentColor" stroke="none">
      <rect x={offset} y={inset} width={bar} height={length} />
      <rect x={inset} y={offset} width={length} height={bar} />
    </svg>
  );
}

/** Bulleted list — the open-chats overview. The bullets are rects rather than
 *  zero-length round-cap strokes: those drop out entirely under
 *  `shape-rendering: crispEdges` (which the chat dock's meta buttons set),
 *  leaving three bare rules that read as a hamburger pushed right of centre.
 *  Rects always paint, and at 12px each lands on a whole pixel beside its
 *  rule. */
export function TaskListGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 6 H20" />
      <path d="M9 12 H20" />
      <path d="M9 18 H20" />
      <rect x="3" y="5" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="3" y="11" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="3" y="17" width="2" height="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Minus — the image viewer's zoom-out control. Same bar as PlusGlyph's, so the
 *  pair matches in weight and length. */
export function MinusGlyph({ size = 14 }: LineGlyphProps) {
  const { box, bar, offset, inset, length } = barGeometry(size);
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="currentColor" stroke="none">
      <rect x={inset} y={offset} width={length} height={bar} />
    </svg>
  );
}

/** Download — arrow dropping into a tray. */
export function DownloadGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 4 V15" />
      <path d="M7 10 L12 15 L17 10" />
      <path d="M5 19 H19" />
    </svg>
  );
}

/** Close (✕) — dismisses the image viewer. */
export function CloseGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 6 L18 18" />
      <path d="M18 6 L6 18" />
    </svg>
  );
}

/** Vertical dots (kebab) — the mobile header's "more controls" toggle. Filled
 *  circles rather than strokes: at small sizes dots read as dots only when
 *  solid. */
export function MoreVerticalGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="12" cy="5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="19" r="1.9" />
    </svg>
  );
}

/** Left arrow — returns the mobile header's "more" view to the primary one.
 *  24-viewBox twin of IconButton's arrowBack, sized for bespoke buttons. */
export function ArrowLeftGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 6 L8 12 L14 18" />
      <path d="M8 12 H19" />
    </svg>
  );
}

/** Two overlapping rounded squares — the traditional "copy to clipboard"
 *  glyph. Shared by every copy action so the symbol reads the same wherever it
 *  appears (front sheet over a back sheet peeking top-left). */
export function CopyGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="13" height="13" rx="2.5" />
      <path d="M16 8 V5 a2 2 0 0 0-2-2 H5 a2 2 0 0 0-2 2 v9 a2 2 0 0 0 2 2 h3" />
    </svg>
  );
}

/** Processor chip — the saved model profiles. */
export function ModelChipGlyph({ size = 14 }: LineGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="8" y="8" width="8" height="8" rx="1" />
      <path d="M10 8 V5" />
      <path d="M14 8 V5" />
      <path d="M10 19 V16" />
      <path d="M14 19 V16" />
      <path d="M8 10 H5" />
      <path d="M8 14 H5" />
      <path d="M16 10 H19" />
      <path d="M16 14 H19" />
    </svg>
  );
}
