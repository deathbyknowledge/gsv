import type { Environment } from "./config";
import { OpenAiRealtimeConnector, type RealtimeConnector } from "./realtime";
import { TwilioTelephony, type Telephony } from "./twilio";

/** Provider construction, replaced by fakes in tests. */
export const providers = {
  telephony: (env: Environment): Telephony => new TwilioTelephony(env),
  realtime: (): RealtimeConnector => new OpenAiRealtimeConnector(),
};
