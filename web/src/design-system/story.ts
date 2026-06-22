import type { ComponentChildren } from "preact";

/**
 * A single catalog entry. Each ported component contributes one `Story`,
 * authored in `web/src/design-system/stories/<Name>.story.tsx` and registered
 * in `web/src/design-system/catalog.tsx`.
 */
export interface Story {
  /** Display name, e.g. "Button". */
  title: string;
  /** Catalog group the story is filed under. */
  group: StoryGroup;
  /** One-line description of the component's role (optional). */
  blurb?: string;
  /** Renders the component's variants/states for review. */
  render: () => ComponentChildren;
}

export type StoryGroup =
  | "Foundations"
  | "Forms"
  | "Feedback"
  | "Data Display"
  | "Chrome"
  | "Composite";

export const STORY_GROUP_ORDER: StoryGroup[] = [
  "Foundations",
  "Forms",
  "Feedback",
  "Data Display",
  "Chrome",
  "Composite",
];
