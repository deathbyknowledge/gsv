import { Fragment } from "preact";
import { useRef, useState } from "preact/hooks";
import { IconButton } from "./IconButton";
import { ListRow, type ListRowStatus } from "./ListRow";
import "./ShipSection.css";

export interface ShipSectionRow {
  id: string;
  /** Optional eyebrow label grouping the rows beneath it (e.g. "LOCAL FILES"). */
  group?: string;
  /** Leading icon glyph for the list row (ignored for the highlight item, which
   // SAFETY: Component boundary provides the asserted DOM/test shape.
   *  uses the cover image as its avatar). */
  icon?: string;
  /** Object title. */
  title: string;
  /** Trailing status dot tone (dot always shown; label reveals on hover). */
  status?: ListRowStatus;
  statusLabel?: string;
  /** Optional description line. */
  description?: string;
  // SAFETY: Component boundary provides the asserted DOM/test shape.
  /** Renders as the highlighted / featured item (the back's highlight section). */
  highlight?: boolean;
  onClick?: () => void;
}

export interface ShipSectionEmptyGroup {
  /** Eyebrow label for the empty group (e.g. "PRIVATE"). */
  group: string;
  /** Message shown beneath it (e.g. "Nothing here yet!"). */
  message: string;
}

export interface ShipSectionProps {
  /** Room title (e.g. FILES / LIBRARY / REPOS). */
  title: string;
  /** Cover image — the front face and the back's highlight avatar. */
  image: string;
  rows: readonly ShipSectionRow[];
  /** Groups with no rows yet, rendered after the row groups with an inline
   *  empty-state (e.g. REPOS → PRIVATE → "Nothing here yet!"). */
  emptyGroups?: readonly ShipSectionEmptyGroup[];
  /** Call-to-action, revealed on back hover (blue underlined link). */
  ctaLabel?: string;
  onCta?: () => void;
  className?: string;
}

// Timestamp of the last real pointer movement, shared across cards. A hover
// that flips the card must be an *active* hover-in (pointer moving); a cursor
// merely resting where a card mounts — at page load, or after a turn-back —
// fires a synthetic mouseenter with no preceding movement, which we ignore.
let lastPointerMoveAt = -Infinity;
if ("document" in globalThis) {
  document.addEventListener(
    "pointermove",
    () => { lastPointerMoveAt = performance.now(); },
    { capture: true, passive: true },
  );
}

/** ShipSection — a "room" flip card (FILES / LIBRARY / REPOS). The FRONT is a
 *  purple-tinted cover image + title; hovering/clicking/focusing it flips to the
 *  BACK, which stays until the turn-back button flips it forward. The BACK shows
 *  a highlighted item (avatar + label + name), a grouped list, and a hover CTA. */
export function ShipSection({
  title,
  image,
  rows,
  emptyGroups,
  ctaLabel,
  onCta,
  className = "",
}: ShipSectionProps) {
  const [flipped, setFlipped] = useState(false);
  // Turning back disarms hover-to-flip until the pointer actually leaves the
  // card (re-armed on the root's mouseleave). Otherwise the cursor left resting
  // on the card after a turn-back fires a synthetic mouseenter that would
  // instantly flip it right back — making the front impossible to rest on.
  const hoverArmed = useRef(true);

  const flipToBackOnHover = () => {
    // Require both an armed card and a *moving* pointer: the first rules out the
    // rest-after-turn-back case, the second the rest-at-page-load case.
    if (hoverArmed.current && performance.now() - lastPointerMoveAt < 120) {
      setFlipped(true);
    }
  };
  const flipToFront = () => {
    hoverArmed.current = false;
    setFlipped(false);
  };

  const highlightRow = rows.find((row) => row.highlight) ?? rows[0];
  const listRows = rows.filter((row) => row.id !== highlightRow?.id);

  const rootClass = `gsv-ss ${className}`.trim();

  return (
    <div
      class={rootClass}
      data-flipped={flipped ? "true" : "false"}
      onMouseLeave={() => { hoverArmed.current = true; }}
    >
      <div class="gsv-ss-inner">
        <button
          type="button"
          class="gsv-ss-front"
          aria-hidden={flipped ? "true" : undefined}
          tabIndex={flipped ? -1 : undefined}
          aria-label={`${title} — reveal details`}
          onMouseEnter={flipToBackOnHover}
          onClick={() => setFlipped(true)}
        >
          <span class="gsv-ss-cover">
            <img class="gsv-ss-cover-img" src={image} alt="" loading="lazy" />
            <span class="gsv-ss-img-tint" aria-hidden="true" />
          </span>
          <span class="gsv-ss-front-title">{title}</span>
        </button>

        <div class="gsv-ss-back" aria-hidden={flipped ? undefined : "true"}>
          <div class="gsv-ss-back-head">
            <span class="gsv-ss-back-title gsv-label">{title}</span>
            <IconButton
              glyph="arrowBack"
              size="small"
              variant="floating"
              ariaLabel="Turn card back"
              onClick={flipToFront}
            />
          </div>

          <div class="gsv-ss-back-body">
            {highlightRow ? (
              <button
                type="button"
                class="gsv-ss-highlight"
                disabled={!highlightRow.onClick}
                onClick={highlightRow.onClick}
              >
                <span class="gsv-ss-avatar" aria-hidden="true">
                  <img class="gsv-ss-avatar-img" src={image} alt="" loading="lazy" />
                  <span class="gsv-ss-img-tint" />
                </span>
                <span class="gsv-ss-highlight-main">
                  {highlightRow.group ? (
                    <span class="gsv-ss-hl-label gsv-sublabel">{highlightRow.group}</span>
                  ) : null}
                  <span class="gsv-ss-hl-name">{highlightRow.title}</span>
                </span>
              </button>
            ) : null}

            {listRows.map((row, index) => {
              const showGroup = row.group && row.group !== listRows[index - 1]?.group;
              return (
                <Fragment key={row.id}>
                  {showGroup ? <span class="gsv-ss-list-label gsv-sublabel">{row.group}</span> : null}
                  <ListRow
                    className="gsv-ss-list-row"
                    icon={row.icon}
                    iconTitle={row.title}
                    label={row.title}
                    status={row.status ?? "none"}
                    statusDotPlacement="trailing"
                    statusLabel={row.statusLabel}
                    chevron={Boolean(row.onClick)}
                    onClick={row.onClick}
                    style={{ minHeight: "44px", padding: "13px 16px" }}
                  />
                </Fragment>
              );
            })}

            {emptyGroups?.map((eg) => (
              <div class="gsv-ss-list-group" key={`empty-${eg.group}`}>
                <span class="gsv-ss-list-label gsv-sublabel">{eg.group}</span>
                <span class="gsv-ss-empty gsv-listitem">{eg.message}</span>
              </div>
            ))}
          </div>

          {ctaLabel ? (
            <button type="button" class="gsv-ss-cta" onClick={onCta} disabled={!onCta}>
              <span class="gsv-ss-cta-label">{ctaLabel}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
