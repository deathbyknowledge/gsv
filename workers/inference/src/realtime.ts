import { WorkerEntrypoint } from "cloudflare:workers";
import { createRealtimeSession, type RealtimeEnvironment } from "@humansandmachines/gsv-inference/realtime";
import type { PhoneRealtimeSession, PhoneRealtimeSessionRequest, PhoneRealtimeSessions } from "@humansandmachines/gsv/services/phone";

/** This entrypoint is bound only to the calls service, with explicit realtime authority. */
export class InferenceRealtimeEntrypoint extends WorkerEntrypoint<RealtimeEnvironment, { authority?: string }> implements PhoneRealtimeSessions {
  async createRealtimeSession(input: PhoneRealtimeSessionRequest): Promise<PhoneRealtimeSession> {
    if (this.ctx.props.authority !== "realtime-sessions") throw new Error("Realtime session authority is required");
    return createRealtimeSession(this.env, input);
  }
}
