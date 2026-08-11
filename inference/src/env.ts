import type { ManagedInferenceUsageService } from "@humansandmachines/gsv/protocol";

export type InferenceEnv = Omit<
  Env,
  | "ACCOUNTS"
  | "MANAGED_INFERENCE_ENABLED"
  | "MANAGED_INFERENCE_MONTHLY_LIMIT_NANO_USD"
> & {
  ACCOUNTS: ManagedInferenceUsageService;
  MANAGED_INFERENCE_ENABLED: boolean;
  MANAGED_INFERENCE_MONTHLY_LIMIT_NANO_USD: number;
};
