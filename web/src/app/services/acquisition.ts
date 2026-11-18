const marketingOrigin = "https://ship.space";
export const attributionKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
type Milestone = "CompleteRegistration";
type AcquisitionClient = { track(name: Milestone, eventId: string, occurredAt: number): void };
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

