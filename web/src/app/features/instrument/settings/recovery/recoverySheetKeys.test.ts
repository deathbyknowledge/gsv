import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import encodeQR from "qr";
import { describe, expect, it, vi } from "vitest";
import { deriveRecoveryKey, makeRecoverySheet } from "./recoverySheetKeys";

// The fixed vectors docs/architecture/open-network.md lists: BIP39's own test entropies, then each step of the derivation.
const VECTORS = [
  {
    words: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    entropy: "00000000000000000000000000000000",
    privateKey: "43760196af39f8db366a7b0baf5c732e35c9cfcc37c01e77cf067aa7227a768e",
    key: "did:key:zDnaewGvRNmdcuZt2bW7LxUWxazHNEUMBQmpF9UqyVVVs19Hk",
    code: "E35-BAN",
    qr: "z42tnRekTm23DJg8zCE8SfEy19MNf2irnT9zcCAmamcFVEvR",
  },
  {
    words: "legal winner thank year wave sausage worth useful legal winner thank yellow",
    entropy: "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
    privateKey: "f2e63c62911001b87350fc9f19ab2e2a88ffe8d899606b5c2a0cbeb7fc79035c",
    key: "did:key:zDnaeawtd1GGcWMADtNZPXHbhGtfX7F3dPFfh116iVeEz62yp",
    code: "PJW-P30",
    qr: "z42tzEVMUGhTswAVhmB438G8FwMCuCrCNc9E9SVPyYC3Xskf",
  },
];

describe("a recovery sheet's key", () => {
  it.each(VECTORS)("derives $key from its words", async (vector) => {
    const entropy = mnemonicToEntropy(vector.words, wordlist);
    expect(hex(entropy)).toBe(vector.entropy);
    const derived = await deriveRecoveryKey(entropy);
    expect(hex(derived.privateKey)).toBe(vector.privateKey);
    expect(derived.key).toBe(vector.key);
    expect(derived.privateMultikey).toBe(vector.qr);
  });

  it("makes a sheet whose words, sheet code and QR code all hold the same key", async () => {
    const vector = VECTORS[1]!;
    vi.spyOn(crypto, "getRandomValues").mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint8Array)) throw new Error("The sheet draws its entropy as bytes");
      array.set(mnemonicToEntropy(vector.words, wordlist));
      return array;
    });
    const sheet = await makeRecoverySheet();
    expect(sheet.words.join(" ")).toBe(vector.words);
    expect(sheet.key).toBe(vector.key);
    expect(sheet.code).toBe(vector.code);
    expect(sheet.qr).toEqual(encodeQR(vector.qr, "raw", { ecc: "medium" }));
    vi.restoreAllMocks();
  });

  it("makes a different sheet each time, with 12 words from the BIP39 English list", async () => {
    const [first, second] = await Promise.all([makeRecoverySheet(), makeRecoverySheet()]);
    expect(first.words).toHaveLength(12);
    expect(validateMnemonic(first.words.join(" "), wordlist)).toBe(true);
    expect(first.key).not.toBe(second.key);
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
