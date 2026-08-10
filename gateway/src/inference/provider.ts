import type { Provider } from "@earendil-works/pi-ai";
import { stableOpaqueId } from "../shared/stable-id";

export type InferenceAttribution = {
  installationId: string;
  logicalRequestId: string;
  actor: {
    localUid: number;
    processId?: string;
    runId?: string;
  };
};

export type InferenceProviderFactory = {
  id: string;
  create(attribution: InferenceAttribution): Provider;
};

export async function inferenceLogicalRequestId(
  parts: readonly (string | number | null | undefined)[],
): Promise<string> {
  return await stableOpaqueId("inference", parts);
}
