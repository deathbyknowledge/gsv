import type { CommandContext } from "just-bash/browser";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function decodeJustBashStdin(stdin: CommandContext["stdin"]): string {
  const value = stdin as unknown as string;
  let hasHighByte = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0xff) return value;
    if (code > 0x7f) hasHighByte = true;
  }
  if (!hasHighByte) return value;

  const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return value;
  }
}
