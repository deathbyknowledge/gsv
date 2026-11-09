import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ConversationMessage } from "@humansandmachines/gsv/protocol";

const marketingOrigin = "https://ship.space";
export const attributionKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
type Milestone = "CompleteRegistration" | "FirstTaskSubmitted";
type AcquisitionClient = { track(name: Milestone, eventId: string, occurredAt: number): void };
type HistoryClient = { conversation: Pick<GSVClient["conversation"], "history"> };
declare global {
  interface Window {
    shipAcquisition?: AcquisitionClient;
    shipAcquisitionReady?: Promise<void>;
  }
}
let ready: Promise<AcquisitionClient | undefined> | undefined;

/** Only campaign tags travel onward; onboarding tokens and invitation fragments stay intact. */
export function attributedDestination(destination: string, source: string): string {
  const url = new URL(destination);
  const params = new URL(source).searchParams;
  for (const key of attributionKeys) {
    const value = params.get(key);
    if (value && /^[a-zA-Z0-9_.~ -]{1,100}$/.test(value)) url.searchParams.set(key, value);
  }
  return url.href;
}

/** First-party coordinator only. No Meta SDK, cookies or form inspection in the product. */
export function startAcquisition(): void {
  const target = globalThis.window;
  if (ready || import.meta.env.VITE_ACQUISITION_ENABLED !== "true" || !target) return;
  const url = new URL(target.location.href);
  if (url.protocol !== "https:" || !(url.hostname === "ship.space" || url.hostname.endsWith(".ship.space"))) return;
  ready = new Promise((resolve) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = `${marketingOrigin}/acquisition-client.js`;
    script.referrerPolicy = "no-referrer";
    const attribution: Record<string, string> = {};
    for (const key of attributionKeys) {
      const value = url.searchParams.get(key);
      if (value && /^[a-zA-Z0-9_.~ -]{1,100}$/.test(value)) attribution[key] = value;
    }
    script.dataset.acquisitionAttribution = JSON.stringify(attribution);
    script.onload = () => { void Promise.resolve(target.shipAcquisitionReady).then(() => resolve(target.shipAcquisition)).catch(() => resolve(undefined)); };
    script.onerror = () => resolve(undefined);
    document.head.appendChild(script);
  });
}

export async function milestoneId(kind: Milestone, opaqueIdentity: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ship-acquisition-v1:${kind}:${opaqueIdentity}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Called only after a successful sys.setup acknowledgement for a managed signup. */
export function captureRegistration(uid: number): void {
  if (!ready) return;
  const occurredAt = Date.now();
  void (async () => {
    const id = await milestoneId("CompleteRegistration", `${window.location.origin}:${uid}`);
    (await ready)?.track("CompleteRegistration", id, occurredAt);
  })().catch(() => { /* Measurement cannot change successful account creation. */ });
}

/** Determine first user submission from canonical history, never from a click or draft.
 * Earlier user messages from other browsers/messengers also prevent a false first task.
 * Content is read only through the owner's existing authenticated history API; it is
 * never copied into the acquisition payload. */
export async function isFirstUserSubmission(client: HistoryClient, message: ConversationMessage): Promise<boolean> {
  if (message.author.kind !== "user" || message.origin.kind !== "client") return false;
  let beforeSequence = message.sequence;
  while (beforeSequence > 1) {
    const page = await client.conversation.history({ conversationId: message.conversationId, beforeSequence, limit: 100 });
    if (page.messages.some((row) => row.author.kind === "user")) return false;
    if (!page.hasMore) return true;
    const first = Math.min(...page.messages.map((row) => row.sequence));
    if (!Number.isSafeInteger(first) || first >= beforeSequence) return false;
    beforeSequence = first;
  }
  return true;
}

export function captureFirstTask(client: HistoryClient, message: ConversationMessage): void {
  if (!ready) return;
  const occurredAt = Date.now();
  void (async () => {
    if (!await isFirstUserSubmission(client, message)) return;
    const id = await milestoneId("FirstTaskSubmitted", message.id);
    (await ready)?.track("FirstTaskSubmitted", id, occurredAt);
  })().catch(() => { /* Unknown or unavailable history is not evidence of a first task. */ });
}
