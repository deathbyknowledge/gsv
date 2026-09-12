import type { ManagedInferenceWorkload } from "@humansandmachines/gsv/protocol";
import { stableOpaqueId } from "../shared/stable-id";

export type InferenceAttribution = {
  installationId: string;
  logicalRequestId: string;
  actor: {
    localUid: number;
    processId?: string;
    runId?: string;
  };
  workload?: ManagedInferenceWorkload;
};

export async function inferenceLogicalRequestId(
  parts: readonly (string | number | null | undefined)[],
): Promise<string> {
  return await stableOpaqueId("inference", parts);
}
