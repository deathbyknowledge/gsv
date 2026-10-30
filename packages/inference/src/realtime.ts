import type { PhoneRealtimeSession, PhoneRealtimeSessionRequest } from "@humansandmachines/gsv/services/phone";
import * as z from "zod/mini";
import { opaqueId, requireActiveInstallation, type ExecutorEnvironment } from "./executor/config";

export type RealtimeEnvironment = Pick<ExecutorEnvironment, "INSTALLATION_DIRECTORY"> & {
  /** Operator credential for realtime sessions; it never leaves inference. */
  INFERENCE_REALTIME_API_KEY?: string;
  /** Models a realtime credential may be minted for. */
  INFERENCE_REALTIME_MODELS?: string[];
};

const OPENAI_ORIGIN = "https://api.openai.com";
/** Long enough to open the socket; an open session outlives its credential. */
const CREDENTIAL_SECONDS = 60;

const clientSecretSchema = z.object({
  value: z.string().check(z.minLength(1)),
  expires_at: z.number(),
});

/**
 * Mints a short-lived credential for one realtime model session. The session is
 * pinned to its model and telephony audio so the credential cannot open anything else.
 */
export async function createRealtimeSession(
  env: RealtimeEnvironment,
  input: PhoneRealtimeSessionRequest,
  fetcher: typeof fetch = fetch,
): Promise<PhoneRealtimeSession> {
  const installationId = opaqueId(input.installationId);
  opaqueId(input.callId);
  if (!env.INFERENCE_REALTIME_API_KEY) throw new Error("Realtime sessions are not configured");
  if (!env.INFERENCE_REALTIME_MODELS?.includes(input.model)) throw new Error("Realtime model is not allowed");
  await requireActiveInstallation(env, installationId);

  const response = await fetcher(`${OPENAI_ORIGIN}/v1/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INFERENCE_REALTIME_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: CREDENTIAL_SECONDS },
      session: {
        type: "realtime",
        model: input.model,
        audio: { input: { format: { type: "audio/pcmu" } }, output: { format: { type: "audio/pcmu" } } },
      },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Realtime provider refused the session (HTTP ${response.status})`);
  }
  const secret = clientSecretSchema.parse(await response.json());
  return {
    provider: "openai",
    model: input.model,
    url: `${OPENAI_ORIGIN.replace("https:", "wss:")}/v1/realtime`,
    clientSecret: secret.value,
    expiresAt: secret.expires_at * 1000,
  };
}
