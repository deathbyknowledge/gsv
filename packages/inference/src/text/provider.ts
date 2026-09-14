import type { Provider } from "@earendil-works/pi-ai";
import type { ManagedInferenceWorkload } from "@humansandmachines/gsv/protocol";

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

export type InferenceProviderFactory = {
  id: string;
  create(attribution: InferenceAttribution, options?: { deadlineAt: number }): Provider;
};
