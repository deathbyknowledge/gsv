import { describe, expect, it } from "vitest";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import { createRealtimeSession, type RealtimeEnvironment } from "./realtime";

function environment(state = "active", overrides: Partial<RealtimeEnvironment> = {}): RealtimeEnvironment {
  const directory = {
    async resolveInstallation(installationId: string) {
      return { found: true, installationId, state, handle: installationId, canonicalOrigin: "https://example.invalid" };
    },
  } as unknown as InstallationDirectoryService;
  return { INSTALLATION_DIRECTORY: directory, INFERENCE_REALTIME_API_KEY: "operator-key", INFERENCE_REALTIME_MODELS: ["gpt-realtime-2.1"], ...overrides };
}

const request = { installationId: "inst_1", callId: "call_1", model: "gpt-realtime-2.1" };

describe("realtime sessions", () => {
  it("mints a short-lived credential pinned to the model and telephony audio", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json({ value: "ek_short", expires_at: 1_800_000_000 });
    }) as typeof fetch;
    const session = await createRealtimeSession(environment(), request, fetcher);
    expect(session).toEqual({ provider: "openai", model: "gpt-realtime-2.1", url: "wss://api.openai.com/v1/realtime", clientSecret: "ek_short", expiresAt: 1_800_000_000_000 });
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(new Headers(sent[0]?.init.headers).get("Authorization")).toBe("Bearer operator-key");
    const body = JSON.parse(String(sent[0]?.init.body));
    expect(body.session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1",
      audio: { input: { format: { type: "audio/pcmu" } }, output: { format: { type: "audio/pcmu" } } } });
    expect(body.expires_after.seconds).toBeLessThanOrEqual(60);
  });

  it("refuses before contacting the provider when the request is not admissible", async () => {
    let calls = 0;
    const fetcher = (async () => { calls += 1; return Response.json({}); }) as typeof fetch;
    await expect(createRealtimeSession(environment("restricted"), request, fetcher)).rejects.toThrow("Installation is not active");
    await expect(createRealtimeSession(environment(), { ...request, model: "gpt-5" }, fetcher)).rejects.toThrow("Realtime model is not allowed");
    await expect(createRealtimeSession(environment("active", { INFERENCE_REALTIME_API_KEY: undefined }), request, fetcher)).rejects.toThrow("not configured");
    await expect(createRealtimeSession(environment(), { ...request, installationId: "../x" }, fetcher)).rejects.toThrow("Invalid inference identity");
    expect(calls).toBe(0);
  });

  it("reports a provider refusal by status without its body", async () => {
    const fetcher = (async () => new Response("{\"error\":{\"message\":\"private detail\"}}", { status: 401 })) as typeof fetch;
    const failure = await createRealtimeSession(environment(), request, fetcher).catch((cause: unknown) => cause);
    expect(String(failure)).toContain("HTTP 401");
    expect(String(failure)).not.toContain("private detail");
  });
});
