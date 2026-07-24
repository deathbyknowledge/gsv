/** Canonical object-type → icon mapping. Single source of truth for the glyph
 *  shown for each GSV object kind (machines, messengers, integrations)
 *  wherever an object is represented — desktop tiles, object
 *  cards, the nav rail, and the console list rows. Change the icon for an object
 *  kind HERE, not in each consumer. */
export type ObjectGlyph = "machines" | "messengers" | "integrations";

export const OBJECT_GLYPH_ICON: Record<ObjectGlyph, string> = {
  machines: "computer",
  messengers: "chat",
  integrations: "weblink",
};
