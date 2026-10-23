/** Server-only. No provider credentials or subscriber objects reach the browser. */
export const BUTTONDOWN_API_VERSION = "2026-04-01";
export type Subscriber = { id: string; email_address: string; type: string; tags: string[]; metadata: Record<string, unknown> };
export const suppressedTypes = new Set(["unsubscribed", "complained", "undeliverable", "blocked", "removed"]);
export class Buttondown {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, method = "GET", body?: object, key?: string): Promise<Subscriber | null> {
    const response = await this.fetcher(`https://api.buttondown.com/v1/subscribers${path}`, {
      method, headers: { Authorization: `Token ${this.key}`, "Content-Type": "application/json", "X-API-Version": BUTTONDOWN_API_VERSION,
        ...(key ? { "X-Idempotency-Key": key } : {}) }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (method === "GET" && response.status === 404) return null;
    // Error bodies may contain personal information. Persist only the status.
    if (!response.ok) throw new Error(`buttondown_http_${response.status}`);
    const value = await response.json() as Partial<Subscriber>;
    if (typeof value.id !== "string" || typeof value.email_address !== "string" || typeof value.type !== "string") throw new Error("buttondown_invalid_response");
    return { id: value.id, email_address: value.email_address, type: value.type,
      tags: Array.isArray(value.tags) ? value.tags : [], metadata: value.metadata ?? {} };
  }
  get(idOrEmail: string): Promise<Subscriber | null> { return this.request(`/${encodeURIComponent(idOrEmail)}`); }
  create(email: string, verified: boolean, requestId: string, ip?: string | null): Promise<Subscriber | null> {
    return this.request("", "POST", { email_address: email, ...(verified ? { type: "regular" } : {}),
      ...(ip ? { ip_address: ip } : {}), tags: ["ship-product-updates"], metadata: { ship_consent_request: requestId } }, requestId);
  }
  unsubscribe(id: string, requestId: string): Promise<Subscriber | null> {
    // Omit tags and metadata: a replacement array would erase existing segmentation.
    return this.request(`/${encodeURIComponent(id)}`, "PATCH", { type: "unsubscribed" }, requestId);
  }
}

export async function verifyButtondownSignature(body: Uint8Array, signature: string | null, secret: string): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, pair => parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", key, bytes, body);
}
