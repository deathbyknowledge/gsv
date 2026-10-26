/** Crockford's base32, which leaves out the letters people misread: I, L, O and U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

/**
 * A recovery sheet's public sheet code, such as `K7Q-P2M`: the first 30 bits
 * of the SHA-256 of the sheet's did:key, in Crockford's base32. It tells the
 * person which sheet is current, and is safe to share.
 */
export async function recoverySheetCode(didKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(didKey)));
  let code = "";
  let value = 0;
  let bits = 0;
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && code.length < CODE_LENGTH) {
      code += CROCKFORD[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (code.length === CODE_LENGTH) break;
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
