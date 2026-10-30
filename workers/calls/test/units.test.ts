import { describe, expect, it } from "vitest";
import { agentTools, disclosed, serviceRules, transcriptionLanguage } from "../src/agent";
import { openAiSession } from "../src/realtime";
import { routeDestination } from "../src/numbers";
import { conferenceTwiml, streamTwiml, twilioSignature, TwilioTelephony, verifyTwilioSignature } from "../src/twilio";
import type { Environment } from "../src/config";

const routes = [{ prefix: "+1", from: "+13213604274", locationHint: "enam" as const }, { prefix: "+34", from: "+34910000001" }];
const brief = { to: "+34910000000", onBehalfOf: "Esteve Jamez", goal: "Book a table" };

describe("destinations", () => {
  it("chooses the pool number by longest prefix", () => {
    expect(routeDestination("+14155550123", routes)).toEqual({ to: "+14155550123", from: "+13213604274", locationHint: "enam" });
    expect(routeDestination("+34910000000", routes).from).toBe("+34910000001");
  });
  it.each(["+19005550123", "+19765550123", "+14159111234", "+1415555012", "+34806123456", "+34905123456"])("refuses special service number %s", to => {
    expect(() => routeDestination(to, routes)).toThrow(/cannot be called/);
  });
  it("refuses countries without a route and malformed numbers", () => {
    expect(() => routeDestination("+31201234567", routes)).toThrow(/not available/);
    expect(() => routeDestination("911", routes)).toThrow(/international number/);
  });
});

describe("twilio", () => {
  const url = "https://calls.example.test/twilio/status?i=inst&c=0123";
  const params: Array<[string, string]> = [["CallSid", "CA123"], ["CallStatus", "ringing"], ["To", "+13213604274"], ["AccountSid", "ACtest"]];
  it("signs webhooks the way Twilio does", async () => {
    // Computed independently with Python's hmac module.
    expect(await twilioSignature("test-auth-token", url, params)).toBe("HH/fwXX7Q6jFPJpSyhCoor+wnx0=");
    expect(await verifyTwilioSignature("test-auth-token", url, params, "HH/fwXX7Q6jFPJpSyhCoor+wnx0=")).toBe(true);
    expect(await verifyTwilioSignature("test-auth-token", url, [...params, ["Extra", "1"]], "HH/fwXX7Q6jFPJpSyhCoor+wnx0=")).toBe(false);
    expect(await verifyTwilioSignature("test-auth-token", url, params, null)).toBe(false);
  });
  it("mints a voice token for one identity with the take-over application", async () => {
    // SAFETY: Token minting reads only the Twilio credential fields supplied here.
    const env = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_API_KEY_SID: "SKtest", TWILIO_API_KEY_SECRET: "secret", TWILIO_TWIML_APP_SID: "APtest" } as Environment;
    const { token, expiresAt } = await new TwilioTelephony(env).joinToken("owner_abc", 120);
    const [header, payload] = token.split(".").slice(0, 2).map(part => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(header).toEqual({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" });
    expect(payload).toMatchObject({ iss: "SKtest", sub: "ACtest", grants: { identity: "owner_abc", voice: { outgoing: { application_sid: "APtest" } } } });
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
  it("escapes TwiML attributes", () => {
    expect(streamTwiml("wss://x/a?i=1&c=2", "t\"k", "12#")).toBe('<Response><Play digits="12#"/><Connect><Stream url="wss://x/a?i=1&#38;c=2"><Parameter name="token" value="t&#34;k"/></Stream></Connect></Response>');
    expect(conferenceTwiml("call-1")).toContain(">call-1</Conference>");
  });
});

describe("realtime session", () => {
  it("waits for the callee to finish a thought before taking the turn", () => {
    const session = openAiSession({ instructions: "x", tools: [], voice: "marin", transcriptionModel: "t" } as Parameters<typeof openAiSession>[0]);
    expect(session.audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true });
    expect(session.audio.input.format).toEqual({ type: "audio/pcmu" });
  });
});

describe("voice agent", () => {
  it("offers ask only when the brief lets the agent check", () => {
    expect(agentTools(brief).map(tool => tool.name)).toEqual(["ask", "end_call", "keypad"]);
    expect(agentTools({ ...brief, ifOutsideLimits: "end" }).map(tool => tool.name)).toEqual(["end_call", "keypad"]);
  });
  it("offers ask for a check-in even when limits end the call, and keeps the decision with the owner", () => {
    const checking = { ...brief, ifOutsideLimits: "end" as const, checkIn: "after they answer, before ending the call" };
    expect(agentTools(checking).map(tool => tool.name)).toEqual(["ask", "end_call", "keypad"]);
    const rules = serviceRules(checking);
    expect(rules).toMatch(/Esteve Jamez decides how the call proceeds, never the callee/);
    expect(rules).toMatch(/do not ask the callee what to do next/);
    expect(rules).toMatch(/Do not end the call before then/);
    expect(serviceRules({ ...brief, ifOutsideLimits: "end" })).not.toMatch(/never the callee/);
  });
  it("checks that the opening names the owner and an assistant in any language", () => {
    expect(disclosed("Hi! I'm calling for Esteve, I'm his AI assistant. Could I book a table?", brief)).toBe(true);
    expect(disclosed("¡Hola! Llamo de parte de Estéve, soy su asistente. ¿Podría reservar?", brief)).toBe(true);
    expect(disclosed("Hi, could I book a table for four?", brief)).toBe(false);
    expect(disclosed("Hi, I'm Esteve's colleague", brief)).toBe(false);
  });
  it("derives the transcription hint from the brief language", () => {
    expect(transcriptionLanguage({ ...brief, language: "es-ES" })).toBe("es");
    expect(transcriptionLanguage(brief)).toBeUndefined();
  });
});
