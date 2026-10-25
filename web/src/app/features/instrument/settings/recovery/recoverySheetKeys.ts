import { recoverySheetCode } from "@humansandmachines/gsv/protocol";
import { p256 } from "@noble/curves/nist";
import { base58 } from "@scure/base";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import encodeQR from "qr";

// Loaded only while a person makes a sheet: the word list and the curve stay out of the main bundle.

const SALT = new TextEncoder().encode("GSV recovery sheet v1");
const INFO = new TextEncoder().encode("did:plc rotation key P-256");
/** The multicodec prefixes of a P-256 public and private key, as varints. */
const P256_PUBLIC = [0x80, 0x24];
const P256_PRIVATE = [0x86, 0x26];

/** A sheet being made. It lives only in memory, and only `key` ever leaves the browser. */
export type RecoverySheetDraft = {
  /** The 12 words, which only the paper keeps. */
  words: string[];
  /** The sheet's public half, a P-256 did:key. */
  key: string;
  /** The public sheet code printed on it. */
  code: string;
  /** The QR code's modules, holding the private key as a multikey for atproto tools. */
  qr: boolean[][];
};

/** A fresh sheet from 128 bits of the browser's randomness. */
export async function makeRecoverySheet(): Promise<RecoverySheetDraft> {
  const entropy = crypto.getRandomValues(new Uint8Array(16));
  const { key, privateMultikey } = await deriveRecoveryKey(entropy);
  return {
    words: entropyToMnemonic(entropy, wordlist).split(" "),
    key,
    code: await recoverySheetCode(key),
    qr: encodeQR(privateMultikey, "raw", { ecc: "medium" }),
  };
}

/**
 * The P-256 key the sheet's 16 bytes of BIP39 entropy hold: 48 bytes of
 * HKDF-SHA256 reduced to a scalar from 1 to n − 1, as FIPS 186-5 A.2.1 does.
 */
export async function deriveRecoveryKey(entropy: Uint8Array): Promise<{ privateKey: Uint8Array; key: string; privateMultikey: string }> {
  const material = await crypto.subtle.importKey("raw", Uint8Array.from(entropy), "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: SALT, info: INFO }, material, 384));
  const scalar = BigInt(`0x${hex(okm)}`) % (p256.CURVE.n - 1n) + 1n;
  const privateKey = Uint8Array.from(scalar.toString(16).padStart(64, "0").match(/../g)!, (pair) => Number.parseInt(pair, 16));
  return {
    privateKey,
    key: `did:key:z${base58.encode(Uint8Array.of(...P256_PUBLIC, ...p256.getPublicKey(privateKey, true)))}`,
    privateMultikey: `z${base58.encode(Uint8Array.of(...P256_PRIVATE, ...privateKey))}`,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
