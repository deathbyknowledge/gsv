/**
 * What the space.ship lexicons can't say. Lexicon has no pattern, no
 * fractional number and no union chosen by a field other than `$type`, and it
 * counts string lengths in UTF-8 bytes and graphemes rather than UTF-16 code
 * units. Ships already speak these methods, so each rule keeps a check they
 * make. The field's lexicon description says the same for other implementations.
 *
 * Rules are keyed by the object they apply to: `nsid#def`, or `nsid#main.input`,
 * `.output`, `.params` or `.record` for a lexicon's main object. A field takes
 *   check      zod checks applied after the lexicon's own;
 *   kindUnion  for an `unknown` field, the local objects it holds, chosen by
 *              their `kind`; the union is exported under `name`;
 *   add        an optional field the lexicon can't declare, as zod and TypeScript;
 * and `$refine` checks the whole object. Each rule says why.
 */

const UTF16 = "Ships count this limit in UTF-16 code units.";
const RESOURCE_ID = "z.regex(/^resource:[A-Za-z0-9_-]{1,119}$/)";
const DETAILS = "z.refine((details) => utf8Length(JSON.stringify(details)) <= MAX_FEDERATION_REQUEST_DETAILS_BYTES, \"Must be at most 32 KiB as JSON\")";
const NO_PATTERN = "Lexicon has no pattern.";
const NO_KIND_UNION = "Lexicon unions are chosen by $type; these are chosen by kind.";

/** Identifiers the rules' code uses, by the module that exports them. */
export const SHIP_LEXICON_IMPORTS = {
  "../did": ["DID_PATTERN"],
  "../lexicon": ["utf8Length"],
};

/** Values the rules' code uses by name. The generated module exports each. */
export const SHIP_LEXICON_CONSTANTS = {
  MAX_FEDERATION_REQUEST_DETAILS_BYTES: 32_768,
};

/**
 * Limits a Ship checks before it sends, by the field they limit: a string's or
 * an array's maxLength, or an integer's maximum. The generated module exports
 * each under its name, and the field's schema checks against that constant.
 */
export const SHIP_LEXICON_LIMITS = {
  MAX_FEDERATION_MESSAGE_BYTES: "space.ship.deliver#message text",
  MAX_FEDERATION_MESSAGE_RESOURCES: "space.ship.deliver#message resources",
  MAX_FEDERATION_RESOURCE_BYTES: "space.ship.deliver#resource size",
  MAX_FEDERATION_REQUEST_TITLE_BYTES: "space.ship.deliver#requestOffer title",
};

export const SHIP_LEXICON_RULES = {
  "space.ship.acceptInvitation#main.input": {
    name: { check: ["z.maxLength(256)"], why: UTF16 },
  },
  "space.ship.acceptInvitation#main.output": {
    name: { check: ["z.maxLength(256)"], why: UTF16 },
  },
  "space.ship.acceptMessageRequest#main.input": {
    name: { check: ["z.maxLength(256)"], why: UTF16 },
  },
  "space.ship.sendMessageRequest#main.input": {
    name: { check: ["z.maxLength(80)"], why: UTF16 },
    text: { check: ["z.maxLength(32_768)"], why: UTF16 },
  },
  "space.ship.getAttachment#main.params": {
    id: { check: [RESOURCE_ID], why: NO_PATTERN },
  },
  "space.ship.deliver#main.input": {
    payload: {
      kindUnion: ["#message", "#request", "#requestUpdate", "#contactRevoked"],
      name: "payload",
      why: NO_KIND_UNION,
    },
  },
  "space.ship.deliver#message": {
    $refine: {
      check: "z.refine((message) => message.text.trim().length > 0 || (message.resources?.length ?? 0) > 0, \"A message needs text or a file\")",
      why: "Lexicon can't make one field required only when another is empty.",
    },
  },
  "space.ship.deliver#resource": {
    id: { check: [RESOURCE_ID], why: NO_PATTERN },
    filename: { check: ["z.maxLength(1_024)"], why: UTF16 },
    transcription: { check: ["z.maxLength(32_768)"], why: UTF16 },
    duration: {
      add: { type: "number", schema: "z.number().check(z.nonnegative())" },
      why: "Lexicon has no fractional number, and durations are fractional seconds.",
    },
  },
  "space.ship.deliver#social": {
    provenance: { kindUnion: ["#humanProvenance", "#processProvenance"], name: "provenance", why: NO_KIND_UNION },
  },
  "space.ship.deliver#messageRef": {
    did: { check: ["z.regex(DID_PATTERN)"], why: "Ships resolve did:plc and did:web." },
  },
  "space.ship.deliver#requestOffer": {
    kind: { check: ["z.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i)"], why: NO_PATTERN },
    title: { check: ["z.refine((title) => title.trim().length > 0, \"Must be more than whitespace\")"], why: NO_PATTERN },
    details: { check: [DETAILS], why: "Lexicon can't limit an object's encoded size." },
  },
  "space.ship.deliver#requestUpdate": {
    details: { check: [DETAILS], why: "Lexicon can't limit an object's encoded size." },
  },
};
