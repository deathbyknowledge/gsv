import type { ComponentChildren } from "preact";
import { Breadcrumbs, type Crumb, type BreadcrumbsSize } from "./Breadcrumbs";
import { SectionHeader } from "./SectionHeader";
import "./PageHeader.css";

export interface PageHeaderProps {
  // ---- Row 1: breadcrumb trail ----
  /** Ordered root → current; the last item is the current page. */
  items: Crumb[];
  onBack?: () => void;
  backLabel?: string;
  maxVisible?: number;
  breadcrumbSize?: BreadcrumbsSize;
  currentAriaCurrent?: "page" | "location" | "step" | "true";

  // ---- Row 2: section header ----
  title: string;
  meta?: string;
  titleSize?: "section" | "title";
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  chevron?: boolean;
  /** Right-aligned interactive controls on the title row (e.g. a close ✕). */
  actions?: ComponentChildren;
  /** When set, the title becomes the interactive button (heading semantics kept). */
  onTitleClick?: () => void;
  /** Accessible name for the clickable title. */
  titleAriaLabel?: string;

  className?: string;
}

/** PageHeader — the standard two-row page header: a `Breadcrumbs` trail (row 1)
 *  stacked over a `SectionHeader` title block (row 2). This is a pure
 *  composition of the two DS primitives — it adds no bespoke styling to either,
 *  only the column layout and the rule between the rows. Both rows clamp to the
 *  container (no horizontal overflow) and the title is a real heading. */
export function PageHeader({
  items,
  onBack,
  backLabel,
  maxVisible,
  breadcrumbSize = "medium",
  currentAriaCurrent,
  title,
  meta,
  titleSize,
  headingLevel,
  chevron,
  actions,
  onTitleClick,
  titleAriaLabel,
  className = "",
}: PageHeaderProps) {
  return (
    <div class={["gsv-page-header", className].filter(Boolean).join(" ")}>
      <div class="gsv-page-header-crumbs">
        <Breadcrumbs
          items={items}
          onBack={onBack}
          backLabel={backLabel}
          maxVisible={maxVisible}
          size={breadcrumbSize}
          currentAriaCurrent={currentAriaCurrent}
        />
      </div>
      <SectionHeader
        divider
        title={title}
        meta={meta}
        titleSize={titleSize}
        headingLevel={headingLevel}
        chevron={chevron}
        actions={actions}
        onClick={onTitleClick}
        ariaLabel={titleAriaLabel}
      />
    </div>
  );
}
