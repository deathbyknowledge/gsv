import { MAX_WEBHOOK_BYTES } from "./kernel/event-webhook";

const HOOK_PATH = /^\/hooks\/(src_[0-9a-f]{32})(?:\/([A-Za-z0-9_-]{1,128}))?$/;

export type HookPath = { sourceId: string; token: string | null };

type HookReceiver = {
  receiveEventWebhook(
    sourceId: string,
    token: string | null,
    headers: [string, string][],
    body: Uint8Array,
  ): Promise<{ status: number; retryAfter?: number }>;
};

/** A delivery to an event source's public address. Only POST is one; anything else is an ordinary page. */
export function matchHookPath(request: Request): HookPath | null {
  if (request.method !== "POST") return null;
  const match = HOOK_PATH.exec(new URL(request.url).pathname);
  return match ? { sourceId: match[1], token: match[2] ?? null } : null;
}

/** Reads at most one allowed body, whatever length the sender claims, then hands it to the Kernel. */
async function readBounded(request: Request): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.length;
      if (size > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export async function receiveHook(request: Request, { sourceId, token }: HookPath, kernel: HookReceiver): Promise<Response> {
  const body = await readBounded(request);
  if (!body) return new Response(null, { status: 413 });
  const { status, retryAfter } = await kernel.receiveEventWebhook(sourceId, token, Array.from(request.headers), body);
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", ...(retryAfter === undefined ? undefined : { "retry-after": String(retryAfter) }) },
  });
}
