import type { ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { emitTelemetry, type TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";
import { isInitialOnboardingResponsibility } from "./onboarding-responsibility";

export type OnboardingTelemetryScope = {
  env: TelemetryEnvironment | undefined;
  installationId: string;
};

/**
 * Report the resolution of an owner's initial onboarding responsibility on the
 * product stream, once per owner account. The responsibility store calls this
 * after the terminal transition is durable; any other resolved responsibility
 * is ignored, including a caller-created record that reuses the onboarding
 * dedupe key. The record carries only the elapsed time and a count, never the
 * concept names or the owner.
 */
export function emitOnboardingCompleted(
  scope: OnboardingTelemetryScope,
  record: ResponsibilityRecord,
): boolean {
  if (!isInitialOnboardingResponsibility(record) || record.state !== "resolved") {
    return false;
  }
  const resolvedAtMs = record.resolvedAtMs ?? record.updatedAtMs;
  const concepts = record.resolution?.conceptsIntroduced;
  return emitTelemetry(scope.env, {
    installationId: scope.installationId,
    component: "gateway",
    event: {
      stream: "product",
      name: "onboarding.completed",
      properties: {
        durationMs: Math.max(0, Math.round(resolvedAtMs - record.createdAtMs)),
        conceptsCount: Array.isArray(concepts) ? concepts.length : 0,
      },
    },
  });
}
