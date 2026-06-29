import { Fragment } from "preact";
import { IconButton } from "./IconButton";
import "./Breadcrumbs.css";

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export type BreadcrumbsSize = "small" | "medium" | "large";

export interface BreadcrumbsProps {
  /** Ordered root → current; the LAST item is the current page (not a button). */
  items: Crumb[];
  /** When provided, render a leading back IconButton (← / parent). */
  onBack?: () => void;
  size?: BreadcrumbsSize;
  /** When items.length exceeds this, collapse the middle into a single "…". */
  maxVisible?: number;
  /** Accessible name + tooltip for the back button. Default "Up one level". */
  backLabel?: string;
  /** aria-current value for the current crumb. Default "page"; directory-trail
   *  consumers may prefer "location". */
  currentAriaCurrent?: "page" | "location" | "step" | "true";
}

const SIZE_CLASS: Record<BreadcrumbsSize, string> = {
  small: "gsv-bc-sm",
  medium: "gsv-bc-md",
  large: "gsv-bc-lg",
};

/** IconButton size paired with each crumb scale, so the back button tracks the trail. */
const BACK_SIZE: Record<BreadcrumbsSize, "small" | "medium" | "large"> = {
  small: "small",
  medium: "small",
  large: "medium",
};

/** A single rendered node in the trail: either a real crumb or the collapsed ellipsis. */
interface Node {
  kind: "crumb" | "ellipsis";
  label: string;
  /** True for the current page (last crumb): static + aria-current. */
  current: boolean;
  onClick?: () => void;
  /** Hover title — for the ellipsis, the list of hidden labels. */
  title?: string;
  /** For the ellipsis: full accessible name describing the collapsed levels. */
  ariaLabel?: string;
}

/**
 * Collapse `items` into the nodes actually rendered. When `maxVisible` is set
 * and exceeded, keep the first crumb + one "…" + the last (maxVisible-1) crumbs.
 * The "…" inherits the onClick of the deepest collapsed (hidden) crumb and lists
 * the hidden labels in its title.
 */
function buildNodes(items: Crumb[], maxVisible?: number): Node[] {
  const n = items.length;
  const toNode = (c: Crumb, i: number): Node => ({
    kind: "crumb",
    label: c.label,
    current: i === n - 1,
    onClick: c.onClick,
  });

  if (maxVisible === undefined || n <= maxVisible || maxVisible < 2) {
    return items.map(toNode);
  }

  // Keep the first crumb, then the last (maxVisible - 1) crumbs; collapse the rest.
  const tailCount = maxVisible - 1;
  const head = items[0];
  const tail = items.slice(n - tailCount);
  const hidden = items.slice(1, n - tailCount);
  const deepestHidden = hidden[hidden.length - 1];
  const hiddenLabels = hidden.map((c) => c.label);

  const ellipsis: Node = {
    kind: "ellipsis",
    label: "…",
    current: false,
    onClick: deepestHidden?.onClick,
    title: hiddenLabels.join(" / "),
    ariaLabel: `${hidden.length} hidden ${hidden.length === 1 ? "level" : "levels"}: ${hiddenLabels.join(", ")}`,
  };

  return [toNode(head, 0), ellipsis, ...tail.map((c, i) => toNode(c, n - tailCount + i))];
}

/** Breadcrumbs — browsable directory/path trail with an optional leading back
 *  button. Earlier crumbs are buttons (when clickable); the last is the current
 *  page. Labels ellipsize rather than hard-clip; long trails collapse via
 *  `maxVisible`. */
export function Breadcrumbs({
  items,
  onBack,
  size = "medium",
  maxVisible,
  backLabel = "Up one level",
  currentAriaCurrent = "page",
}: BreadcrumbsProps) {
  const nodes = buildNodes(items, maxVisible);
  const rootClass = `gsv-bc ${SIZE_CLASS[size]}`;

  return (
    <nav class={rootClass} aria-label="Breadcrumb">
      {onBack ? (
        <span class="gsv-bc-back">
          <IconButton glyph="arrowBack" size={BACK_SIZE[size]} title={backLabel} ariaLabel={backLabel} onClick={onBack} />
        </span>
      ) : null}
      <ol class="gsv-bc-list">
        {nodes.map((node, i) => {
          const clickable = typeof node.onClick === "function";
          const last = i === nodes.length - 1;
          return (
            <Fragment key={`${node.kind}:${node.label}:${i}`}>
              <li class={node.current ? "gsv-bc-item gsv-bc-item-current" : "gsv-bc-item"}>
                {node.kind === "ellipsis" ? (
                  clickable ? (
                    <button type="button" class="gsv-bc-crumb gsv-bc-ellipsis" title={node.title} aria-label={node.ariaLabel} onClick={node.onClick}>
                      {node.label}
                    </button>
                  ) : (
                    <span class="gsv-bc-crumb gsv-bc-ellipsis" title={node.title} role="img" aria-label={node.ariaLabel}>{node.label}</span>
                  )
                ) : node.current ? (
                  <span class="gsv-bc-crumb gsv-bc-current" aria-current={currentAriaCurrent}>{node.label}</span>
                ) : clickable ? (
                  <button type="button" class="gsv-bc-crumb" onClick={node.onClick}>{node.label}</button>
                ) : (
                  <span class="gsv-bc-crumb">{node.label}</span>
                )}
              </li>
              {last ? null : (
                <li class="gsv-bc-sep" aria-hidden="true">/</li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
