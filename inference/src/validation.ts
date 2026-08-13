import {
  GSV_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceActor,
  type ManagedInferenceRequest,
} from "@humansandmachines/gsv/protocol";
import { MANAGED_INFERENCE_MAX_OUTPUT_TOKENS } from "./pricing";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

export function validateManagedInferenceRequest(
  input: ManagedInferenceRequest,
): ManagedInferenceRequest {
  if (!input || typeof input !== "object" || input.version !== 1) {
    throw new Error("Managed inference request version is invalid");
  }
  validateOpaqueId(input.installationId, "installationId");
  validateOpaqueId(input.logicalRequestId, "logicalRequestId");
  validateManagedInferenceActor(input.actor);
  if (input.model !== GSV_INFERENCE_PRODUCT_MODEL) {
    throw new Error("Managed inference model is invalid");
  }
  if (!Array.isArray(input.messages) || !Array.isArray(input.tools ?? [])) {
    throw new Error("Managed inference context is invalid");
  }
  if (
    !Number.isSafeInteger(input.maxOutputTokens)
    || input.maxOutputTokens < 1
    || input.maxOutputTokens > MANAGED_INFERENCE_MAX_OUTPUT_TOKENS
  ) {
    throw new Error("Managed inference output limit is invalid");
  }
  if (
    !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 1
    || input.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("Managed inference timeout is invalid");
  }
  return input;
}

export function validateManagedInferenceActor(
  actor: ManagedInferenceActor,
): ManagedInferenceActor {
  if (
    !actor
    || typeof actor !== "object"
    || !Number.isSafeInteger(actor.localUid)
    || actor.localUid < 0
  ) {
    throw new Error("Managed inference actor is invalid");
  }
  validateOptionalOpaqueId(actor.processId, "processId");
  validateOptionalOpaqueId(actor.runId, "runId");
  return actor;
}

export function validateOpaqueId(value: string, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`Managed inference ${field} is invalid`);
  }
  return value;
}

function validateOptionalOpaqueId(
  value: string | undefined,
  field: string,
): void {
  if (value !== undefined) validateOpaqueId(value, field);
}
