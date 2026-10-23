import { z } from "zod";
/** Server-only. No provider credentials or subscriber objects reach the browser. */
export const BUTTONDOWN_API_VERSION = "2026-04-01";
const subscriberSchema = z.object({ id: z.string(), email_address: z.string(), type: z.string(),
  tags: z.array(z.string()).default([]), metadata: z.object({ ship_consent_request: z.string().optional() }).default({}) });
export type Subscriber = z.infer<typeof subscriberSchema>;
export type SubscriberWrite = { email_address?: string; type?: string; ip_address?: string; tags?: string[]; metadata?: Subscriber["metadata"] };
export const suppressedTypes = new Set(["unsubscribed", "complained", "undeliverable", "blocked", "removed"]);
export class Buttondown {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, method = "GET", body?: SubscriberWrite, key?: string): Promise<Subscriber | null> {
    const headers = new Headers({ Authorization: `Token ${this.key}`, "Content-Type": "application/json", "X-API-Version": BUTTONDOWN_API_VERSION });
    if (key) headers.set("X-Idempotency-Key", key);
    const response = await this.fetcher(`https://api.buttondown.com/v1/subscribers${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (method === "GET" && response.status === 404) return null;
    // Error bodies may contain personal information. Persist only the status.
    if (!response.ok) throw new Error(`buttondown_http_${response.status}`);
    const parsed = subscriberSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("buttondown_invalid_response");
    return parsed.data;
  }
  get(idOrEmail: string): Promise<Subscriber | null> { return this.request(`/${encodeURIComponent(idOrEmail)}`); }
  create(email: string, verified: boolean, requestId: string, ip?: string | null): Promise<Subscriber | null> {
    const body: SubscriberWrite = { email_address: email, tags: ["ship-product-updates"], metadata: { ship_consent_request: requestId } };
    if (verified) body.type = "regular";
    if (ip) body.ip_address = ip;
    return this.request("", "POST", body, requestId);
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
