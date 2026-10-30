import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const request = { installationId: "space_realtime", callId: "call_1", model: "gpt-realtime-2.1" };

describe("realtime session entrypoint", () => {
  it("requires the calls service's realtime authority", async () => {
    await expect(exports.InferenceRealtimeEntrypoint({ props: {} }).createRealtimeSession(request)).rejects.toThrow("Realtime session authority is required");
    await expect(exports.InferenceRealtimeEntrypoint({ props: { authority: "installation-deletion" } }).createRealtimeSession(request)).rejects.toThrow("Realtime session authority is required");
  });

  it("refuses sessions until the operator configures a realtime credential", async () => {
    await expect(exports.InferenceRealtimeEntrypoint({ props: { authority: "realtime-sessions" } }).createRealtimeSession(request)).rejects.toThrow("Realtime sessions are not configured");
  });
});
