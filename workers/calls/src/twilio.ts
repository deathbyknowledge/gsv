import type { Environment } from "./config";

export type DialRequest = {
  to: string;
  from: string;
  twiml: string;
  statusCallback: string;
  machineCallback: string;
  /** Provider-side backstop; the call object enforces the real cap. */
  timeLimitSeconds: number;
};

/** The PSTN leg. Fakes implement it in tests; nothing else talks to Twilio's REST API. */
export interface Telephony {
  dial(request: DialRequest): Promise<{ providerCallId: string }>;
  hangUp(providerCallId: string): Promise<void>;
  /** Replaces the live call's instructions, for keypad tones and take-over. */
  redirect(providerCallId: string, twiml: string): Promise<void>;
  joinToken(identity: string, ttlSeconds: number): Promise<{ token: string; expiresAt: number }>;
}

const API = "https://api.twilio.com/2010-04-01";
const RING_SECONDS = 30;

export class TwilioTelephony implements Telephony {
  constructor(private readonly env: Environment) {}

  async dial(request: DialRequest): Promise<{ providerCallId: string }> {
    const form = new URLSearchParams({
      To: request.to, From: request.from, Twiml: request.twiml,
      StatusCallback: request.statusCallback, StatusCallbackMethod: "POST",
      MachineDetection: "DetectMessageEnd", AsyncAmd: "true",
      AsyncAmdStatusCallback: request.machineCallback, AsyncAmdStatusCallbackMethod: "POST",
      Timeout: String(RING_SECONDS), TimeLimit: String(request.timeLimitSeconds), Record: "false",
    });
    for (const event of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", event);
    const body = await this.request("POST", "/Calls.json", form);
    const sid = (body as { sid?: unknown }).sid;
    if (typeof sid !== "string" || !sid.startsWith("CA")) throw new Error("Twilio returned no call identity");
    return { providerCallId: sid };
  }

  async hangUp(providerCallId: string): Promise<void> {
    await this.request("POST", `/Calls/${encodeURIComponent(providerCallId)}.json`, new URLSearchParams({ Status: "completed" }));
  }

  async redirect(providerCallId: string, twiml: string): Promise<void> {
    await this.request("POST", `/Calls/${encodeURIComponent(providerCallId)}.json`, new URLSearchParams({ Twiml: twiml }));
  }

  async joinToken(identity: string, ttlSeconds: number): Promise<{ token: string; expiresAt: number }> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = (now + ttlSeconds) * 1000;
    const token = await signJwt({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" }, {
      jti: `${this.env.TWILIO_API_KEY_SID}-${now}`, iss: this.env.TWILIO_API_KEY_SID, sub: this.env.TWILIO_ACCOUNT_SID,
      iat: now, nbf: now, exp: now + ttlSeconds,
      grants: { identity, voice: { outgoing: { application_sid: this.env.TWILIO_TWIML_APP_SID } } },
    }, this.env.TWILIO_API_KEY_SECRET);
    return { token, expiresAt };
  }

  private async request(method: string, path: string, form: URLSearchParams): Promise<unknown> {
    const auth = btoa(`${this.env.TWILIO_API_KEY_SID}:${this.env.TWILIO_API_KEY_SECRET}`);
    const response = await fetch(`${API}/Accounts/${encodeURIComponent(this.env.TWILIO_ACCOUNT_SID)}${path}`, {
      method, body: form, headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = (body as { code?: unknown }).code;
      throw new Error(`Twilio request failed with ${response.status}${typeof code === "number" ? ` (code ${code})` : ""}`);
    }
    return body;
  }
}

/**
 * Twilio's webhook signature: HMAC-SHA1 over the full URL followed by each POST
 * parameter's name and value in name order, keyed with the account auth token.
 */
export async function twilioSignature(authToken: string, url: string, params: Iterable<[string, string]>): Promise<string> {
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = url + sorted.map(([name, value]) => name + value).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

export async function verifyTwilioSignature(authToken: string, url: string, params: Iterable<[string, string]>, signature: string | null): Promise<boolean> {
  if (!signature || !authToken) return false;
  const expected = new TextEncoder().encode(await twilioSignature(authToken, url, params));
  const actual = new TextEncoder().encode(signature);
  return expected.byteLength === actual.byteLength && crypto.subtle.timingSafeEqual(expected, actual);
}

const escapeXml = (value: string): string => value.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`);

/** Connects the answered call to its call object; the token proves the stream belongs to this call. */
export function streamTwiml(url: string, streamToken: string, digits?: string): string {
  const play = digits ? `<Play digits="${escapeXml(digits)}"/>` : "";
  return `<Response>${play}<Connect><Stream url="${escapeXml(url)}"><Parameter name="token" value="${escapeXml(streamToken)}"/></Stream></Connect></Response>`;
}

/** Both legs meet in a conference named for the call; either leaving ends it. */
export function conferenceTwiml(name: string): string {
  return `<Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true">${escapeXml(name)}</Conference></Dial></Response>`;
}

export function sayTwiml(message: string): string {
  return `<Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

async function signJwt(header: object, payload: object, secret: string): Promise<string> {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode(header)}.${encode(payload)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))))}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
const base64url = (bytes: Uint8Array): string => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
