import * as z from "zod/mini";

/** What the host keeps of its last request that one relay crawl it. */
export type RelayRequest = {
  /** When the host last asked. */
  at: number;
  /** The host's latest sequence number when the relay last accepted, or null until it has. */
  seq: number | null;
  /** Requests the relay hasn't accepted since it last did. */
  failures: number;
  /** Whether the host has introduced the accounts it held when the relay joined. */
  introduced: boolean;
};

/** The least time between two requests to one relay, as long as Bluesky's PDS waits between them. */
const RECRAWL_MS = 20 * 60_000;
/** The longest a relay that keeps refusing waits for the next request. */
const MAX_WAIT_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** A longer refusal is reported by its status alone. */
const MAX_REFUSAL_BYTES = 4_096;

const refusal = z.object({ error: z.string().check(z.regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)) });

/**
 * Whether to ask a relay to crawl the host now. A relay is asked at once the
 * first time. After that it is asked again only while it hasn't accepted, or
 * accepted before the host's latest event, and twenty minutes after the last
 * request at the soonest; each refusal in a row doubles the wait, up to six
 * hours. A relay that accepted hears nothing while the host has nothing new.
 */
export function crawlDue(last: RelayRequest | undefined, seq: number, now: number): boolean {
  if (!last) return true;
  if (last.seq !== null && last.seq >= seq) return false;
  return now - last.at >= Math.min(MAX_WAIT_MS, RECRAWL_MS * 2 ** last.failures);
}

/**
 * Asks a relay to crawl the host with com.atproto.sync.requestCrawl, which
 * names the host by its hostname, and says whether the relay accepted. The
 * reference relay checks the host's describeServer before it answers, then
 * follows its firehose. A refusal or a relay out of reach is logged as a
 * warning, naming the relay and the XRPC error a small JSON refusal gives.
 */
export async function requestCrawl(relay: string, host: string): Promise<boolean> {
  // The deadline stops once the relay answers; a timer left running would hold the firehose open.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("The relay didn't answer in time", "TimeoutError")), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(new URL("/xrpc/com.atproto.sync.requestCrawl", relay), {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "gsv-pds" },
        body: JSON.stringify({ hostname: host }),
        signal: deadline.signal,
      });
    } catch (error) {
      console.warn(`Relay ${relay} could not be reached to crawl ${host}`, error);
      return false;
    }
    if (response.ok) {
      await response.body?.cancel();
      return true;
    }
    const length = Number(response.headers.get("Content-Length"));
    let name: string | null = null;
    if (length > 0 && length <= MAX_REFUSAL_BYTES) {
      const parsed = z.safeParse(refusal, await response.json().catch(() => null));
      if (parsed.success) name = parsed.data.error;
    } else {
      await response.body?.cancel();
    }
    console.warn(`Relay ${relay} refused to crawl ${host}: HTTP ${response.status}${name ? ` ${name}` : ""}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
