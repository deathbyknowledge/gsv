import { DEEPSEEK_V4_FLASH_0731_PRICE } from "./price-book";

export type ManagedInferenceReleaseGate = {
  readonly releaseId: string;
  readonly provider: string;
  readonly modelRevision: string;
  readonly status: "blocked" | "approved";
  readonly evaluationSuite: string;
  readonly requiredEvaluatedCandidates: number;
  readonly evidenceReports: readonly {
    readonly candidateId: string;
    readonly reportSha256: string;
    readonly suiteSha256: string;
  }[];
  readonly approvals: Readonly<{
    evaluation: boolean;
    privacyAndDataProcessing: boolean;
    security: boolean;
    capacityAndReliability: boolean;
    brandAndAcceptableUse: boolean;
  }>;
};

/**
 * This source-controlled gate is the final production allowlist. Environment
 * variables and a valid provider credential are deliberately insufficient to
 * enable customer prompt processing.
 *
 * Promotion is a separate reviewed change that records immutable, content-free
 * evaluation report digests and flips every required approval together.
 */
export const MANAGED_INFERENCE_RELEASE_GATE: ManagedInferenceReleaseGate = Object.freeze({
  releaseId: "deepseek-v4-flash-0731-candidate-1",
  provider: DEEPSEEK_V4_FLASH_0731_PRICE.provider,
  modelRevision: DEEPSEEK_V4_FLASH_0731_PRICE.modelRevision,
  status: "blocked",
  evaluationSuite: "gsv-managed-text-v1",
  requiredEvaluatedCandidates: 2,
  evidenceReports: Object.freeze([]),
  approvals: Object.freeze({
    evaluation: false,
    privacyAndDataProcessing: false,
    security: false,
    capacityAndReliability: false,
    brandAndAcceptableUse: false,
  }),
});

export function isManagedInferenceReleaseApproved(
  provider: string,
  modelRevision: string,
): boolean {
  const gate = MANAGED_INFERENCE_RELEASE_GATE;
  const evidenceCandidates = new Set(
    gate.evidenceReports.map((report) => report.candidateId),
  );
  const evidenceIsImmutable = gate.evidenceReports.every((report) =>
    /^[a-f0-9]{64}$/.test(report.reportSha256)
    && /^[a-f0-9]{64}$/.test(report.suiteSha256)
  );
  return gate.status === "approved"
    && gate.provider === provider
    && gate.modelRevision === modelRevision
    && evidenceCandidates.size >= gate.requiredEvaluatedCandidates
    && evidenceIsImmutable
    && Object.values(gate.approvals).every(Boolean);
}
