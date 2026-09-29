import * as z from "zod/mini";
import type { DevicePairing } from "./syscalls/pairing";

const CODE_PREFIX = "gsv-pair1_";
export const PAIRING_SECRET_PATTERN = /^[a-f0-9]{64}$/;
export const PAIRING_TARGET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const PAIRING_CREDENTIAL_PATTERN = /^gsv_machine_[a-f0-9]{64}$/;

export type DevicePairingCode = {
  version: 1;
  gatewayUrl: string;
  username: string;
  id: string;
  secret: string;
  targetId: string;
  label: string;
  expiresAt: number;
};

const codeSchema = z.strictObject({
  version: z.literal(1),
  gatewayUrl: z.string(),
  username: z.string().check(z.minLength(1), z.maxLength(128)),
  id: z.string().check(z.uuid()),
  secret: z.string().check(z.regex(PAIRING_SECRET_PATTERN)),
  targetId: z.string().check(z.regex(PAIRING_TARGET_PATTERN)),
  label: z.string().check(z.minLength(1), z.maxLength(100), z.refine((value) => !/[\p{Cc}]/u.test(value))),
  expiresAt: z.number().check(z.int(), z.positive()),
});

export function pairingGatewayUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid pairing gateway");
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Invalid pairing gateway");
  url.pathname = "/ws";
  return url.href;
}

export function createPairingSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPairingCredential(): string {
  return `gsv_machine_${createPairingSecret()}`;
}

export function encodeDevicePairingCode(gatewayUrl: string, pairing: DevicePairing, secret: string): string {
  const value: DevicePairingCode = { version: 1, gatewayUrl: pairingGatewayUrl(gatewayUrl),
    username: pairing.username, id: pairing.id, secret, targetId: pairing.targetId, label: pairing.label, expiresAt: pairing.expiresAt };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return CODE_PREFIX + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeDevicePairingCode(code: string): DevicePairingCode {
  try {
    const raw = code.trim();
    if (raw.length > 4096 || !raw.startsWith(CODE_PREFIX)) throw new Error();
    const encoded = raw.slice(CODE_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    const value = codeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { ...value, gatewayUrl: pairingGatewayUrl(value.gatewayUrl) };
  } catch {
    throw new Error("Invalid GSV pairing code. Copy a new invitation from GSV.");
  }
}
