import type { ComponentChildren } from "preact";
import { InfoTip } from "./InfoTip";
import "./PageHeading.css";

export interface PageHeadingProps {
  title: string;
  /** One-line purpose of the page, revealed by a help icon after the title. */
  description?: string;
  /** Heading level for the title element. Defaults to 1. */
  headingLevel?: 1 | 2 | 3;
  /** id for the heading element, for aria-labelledby on the section. */
  id?: string;
  /** Right-aligned page actions. */
  actions?: ComponentChildren;
}

/** PageHeading — a page or section title with its description tucked into an
 *  InfoTip, and an optional actions slot on the right. Keeps the page quiet:
 *  the explanation is one tap away instead of a paragraph under every title. */
export function PageHeading({ title, description, headingLevel = 1, id, actions }: PageHeadingProps) {
  // SAFETY: headingLevel is typed 1 | 2 | 3, so the template yields one of these three tag names.
  const Heading = `h${headingLevel}` as "h1" | "h2" | "h3";
  return (
    <div class="gsv-page-heading">
      <Heading id={id} class="gsv-page-heading-title">
        <span>{title}</span>
        {description ? <InfoTip text={description} position="right" /> : null}
      </Heading>
      {actions ? <div class="gsv-page-heading-actions">{actions}</div> : null}
    </div>
  );
}
