const CONTROL_CHARACTERS = /\p{Cc}/u;
const textEncoder = new TextEncoder();

export function validatePortableDoIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || CONTROL_CHARACTERS.test(value)
    || !isWellFormedUnicode(value)
    || textEncoder.encode(value).byteLength > 1024
  ) {
    throw new TypeError(`Logical DO ${label} is invalid`);
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
