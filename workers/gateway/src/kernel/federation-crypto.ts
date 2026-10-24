import type { JsonValue } from "@humansandmachines/gsv/protocol";
import {
  jsonObjectSchema,
  jsonPrimitiveSchema,
} from "@humansandmachines/gsv/protocol";

const encoder = new TextEncoder();

export async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function canonicalJson(value: JsonValue): string {
  const primitive = jsonPrimitiveSchema.safeParse(value);
  if (primitive.success) {
    return JSON.stringify(primitive.data);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = jsonObjectSchema.parse(value);
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}
