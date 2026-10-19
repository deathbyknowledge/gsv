// The Instrument UI reports which kind of surface it is running on when it
// connects. The Kernel records this as the connected peer platform and product
// telemetry classifies it; keep the set small and closed.
export type ClientPlatform = "desktop" | "phone" | "tablet" | "web";

type PlatformHints = {
  tauri: boolean;
  userAgent: string;
  // Chromium exposes a structured mobile flag; other browsers leave it undefined.
  userAgentDataMobile: boolean | undefined;
  navigatorPlatform: string;
  maxTouchPoints: number;
};

const PHONE_USER_AGENT = /\b(?:iPhone|iPod|Windows Phone)\b|\bAndroid\b.*\bMobile\b/i;
const TABLET_USER_AGENT = /\biPad\b|\bAndroid\b(?!.*\bMobile\b)|\bTablet\b/i;

export function classifyClientPlatform(hints: PlatformHints): ClientPlatform {
  if (hints.tauri) return "desktop";
  if (hints.userAgentDataMobile === true || PHONE_USER_AGENT.test(hints.userAgent)) return "phone";
  if (TABLET_USER_AGENT.test(hints.userAgent)) return "tablet";
  // iPadOS Safari reports a Mac user agent; touch support tells it apart from a Mac.
  if (/^Mac/i.test(hints.navigatorPlatform) && hints.maxTouchPoints > 1) return "tablet";
  return "web";
}

declare global {
  interface Navigator {
    // User-Agent Client Hints; Chromium only, absent elsewhere.
    userAgentData?: { mobile?: boolean };
  }
}

export function detectClientPlatform(): ClientPlatform {
  // Tests render the UI without a browser window; treat that as a plain web client.
  const browser = globalThis.window;
  if (!browser) return "web";
  return classifyClientPlatform({
    tauri: Boolean(browser.__TAURI__),
    userAgent: browser.navigator.userAgent,
    userAgentDataMobile: browser.navigator.userAgentData?.mobile,
    navigatorPlatform: browser.navigator.platform,
    maxTouchPoints: browser.navigator.maxTouchPoints,
  });
}
