import { vi } from "vitest";
import { providers } from "../src/providers";
import type { RealtimeHandlers, RealtimeSession, RealtimeSetup } from "../src/realtime";
import type { DialRequest, Telephony } from "../src/twilio";

export class FakeTelephony implements Telephony {
  readonly dials: DialRequest[] = [];
  readonly hangUps: string[] = [];
  readonly redirects: Array<{ providerCallId: string; twiml: string }> = [];
  failDial = false;
  /** Holds the dial request open until the test releases it. */
  dialGate?: Promise<void>;
  async dial(request: DialRequest) {
    await this.dialGate;
    if (this.failDial) throw new Error("Twilio request failed with 400 (code 21215)");
    this.dials.push(request);
    return { providerCallId: `CA${this.dials.length.toString().padStart(32, "0")}` };
  }
  async hangUp(providerCallId: string) { this.hangUps.push(providerCallId); }
  async redirect(providerCallId: string, twiml: string) { this.redirects.push({ providerCallId, twiml }); }
  async joinToken(identity: string, ttlSeconds: number) { return { token: `token-for-${identity}`, expiresAt: Date.now() + ttlSeconds * 1000 }; }
}

export class FakeRealtime {
  setup?: RealtimeSetup;
  handlers?: RealtimeHandlers;
  readonly audio: string[] = [];
  readonly informs: Array<{ text: string; respond: boolean }> = [];
  readonly toolResults: Array<{ callId: string; output: string; respond: boolean }> = [];
  responds = 0;
  closed = false;
  readonly session: RealtimeSession = {
    appendAudio: payload => { this.audio.push(payload); },
    inform: (text, respond) => { this.informs.push({ text, respond }); },
    toolResult: (callId, output, respond) => { this.toolResults.push({ callId, output, respond }); },
    respond: () => { this.responds += 1; },
    close: () => { this.closed = true; },
  };
}

/** Installs fresh fakes for one test. */
export function fakeProviders() {
  const telephony = new FakeTelephony();
  const realtime = new FakeRealtime();
  vi.spyOn(providers, "telephony").mockReturnValue(telephony);
  vi.spyOn(providers, "realtime").mockReturnValue({
    open: async (_credential, setup, handlers) => { realtime.setup = setup; realtime.handlers = handlers; return realtime.session; },
  });
  return { telephony, realtime };
}
