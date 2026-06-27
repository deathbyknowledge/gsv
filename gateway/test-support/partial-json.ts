export class PartialJSON extends Error {}

export class MalformedJSON extends Error {}

export const Allow = {
  STR: 1 << 0,
  NUM: 1 << 1,
  ARR: 1 << 2,
  OBJ: 1 << 3,
  NULL: 1 << 4,
  BOOL: 1 << 5,
  NAN: 1 << 6,
  INFINITY: 1 << 7,
  _INFINITY: 1 << 8,
  INF: (1 << 7) | (1 << 8),
  SPECIAL: (1 << 6) | (1 << 7) | (1 << 8),
  ATOM: (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8),
  COLLECTION: (1 << 2) | (1 << 3),
  ALL: (1 << 9) - 1,
} as const;

export function parseJSON(jsonString: string): unknown {
  if (typeof jsonString !== "string") {
    throw new TypeError(`expecting str, got ${typeof jsonString}`);
  }
  if (!jsonString.trim()) {
    throw new PartialJSON("Unexpected end of input");
  }
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    throw error instanceof SyntaxError
      ? new MalformedJSON(error.message)
      : error;
  }
}

export const parse = parseJSON;

export default {
  Allow,
  MalformedJSON,
  PartialJSON,
  parse,
  parseJSON,
};
