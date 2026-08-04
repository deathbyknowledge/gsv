import {
  MANAGED_INFERENCE_PRODUCT_MODEL,
  type ManagedEntitlementProjection,
  type ManagedInferenceRequest,
} from "@humansandmachines/gsv/protocol";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_TIMEOUT_MS = 180_000;
const MAX_TOOLS = 128;
const ACTIVE_ENTITLEMENT_STATES = new Set(["trialing", "active", "past_due"]);

export class InferenceBoundaryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export type ParsedInferenceRequest = ManagedInferenceRequest & {
  serialized: string;
  inputTokenCeiling: number;
};

export function parseInferenceRequest(value: unknown): ParsedInferenceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw boundaryError("Managed inference request is required", 400, "invalid_request");
  }
  const input = value as Partial<ManagedInferenceRequest>;
  if (input.version !== 1) {
    throw boundaryError("Managed inference version is unsupported", 400, "invalid_version");
  }
  const installationId = parseOpaqueId(input.installationId, "installationId");
  const logicalRequestId = parseOpaqueId(input.logicalRequestId, "logicalRequestId");
  if (!input.actor || typeof input.actor !== "object") {
    throw boundaryError("Managed inference actor is required", 400, "invalid_actor");
  }
  if (
    !Number.isSafeInteger(input.actor.localUid)
    || input.actor.localUid! < 0
    || input.actor.localUid! > 2_147_483_647
  ) {
    throw boundaryError("Managed inference actor uid is invalid", 400, "invalid_actor");
  }
  const processId = parseOptionalIdentifier(input.actor.processId, "actor.processId");
  const runId = parseOptionalIdentifier(input.actor.runId, "actor.runId");
  if (input.model !== MANAGED_INFERENCE_PRODUCT_MODEL || input.capability !== "text") {
    throw boundaryError(
      "Managed inference supports only gsv/default text generation",
      400,
      "unsupported_capability",
    );
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw boundaryError("Managed inference messages are required", 400, "invalid_messages");
  }
  assertTextOnly(input.messages);
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > MAX_TOOLS)) {
    throw boundaryError("Managed inference tools are invalid", 400, "invalid_tools");
  }
  if (
    !Number.isSafeInteger(input.maxOutputTokens)
    || input.maxOutputTokens! <= 0
    || input.maxOutputTokens! > MAX_OUTPUT_TOKENS
  ) {
    throw boundaryError(
      `Managed inference maxOutputTokens must be between 1 and ${MAX_OUTPUT_TOKENS}`,
      400,
      "invalid_output_limit",
    );
  }
  if (
    !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs! <= 0
    || input.timeoutMs! > MAX_TIMEOUT_MS
  ) {
    throw boundaryError(
      `Managed inference timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`,
      400,
      "invalid_timeout",
    );
  }
  if (input.reasoning !== undefined && !isReasoning(input.reasoning)) {
    throw boundaryError("Managed inference reasoning is invalid", 400, "invalid_reasoning");
  }

  const request: ManagedInferenceRequest = {
    version: 1,
    installationId,
    logicalRequestId,
    actor: {
      localUid: input.actor.localUid!,
      ...(processId ? { processId } : {}),
      ...(runId ? { runId } : {}),
    },
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    capability: "text",
    ...(typeof input.systemPrompt === "string" && input.systemPrompt.length > 0
      ? { systemPrompt: input.systemPrompt }
      : {}),
    messages: input.messages,
    ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
    maxOutputTokens: input.maxOutputTokens!,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    timeoutMs: input.timeoutMs!,
  };
  const serialized = JSON.stringify(request);
  const serializedBytes = new TextEncoder().encode(serialized).byteLength;
  if (serializedBytes > MAX_REQUEST_BYTES) {
    throw boundaryError("Managed inference request is too large", 413, "request_too_large");
  }
  return {
    ...request,
    serialized,
    // UTF-8 bytes deliberately overestimate tokens for the initial providers.
    inputTokenCeiling: Math.max(1, serializedBytes),
  };
}

export function parseCurrentEntitlement(
  value: ManagedEntitlementProjection | null,
  installationId: string,
  now = Date.now(),
): ManagedEntitlementProjection {
  if (!value || value.installationId !== installationId) {
    throw boundaryError("Managed inference entitlement is unavailable", 403, "not_entitled");
  }
  if (!ACTIVE_ENTITLEMENT_STATES.has(value.state) || value.effectiveAt > now) {
    throw boundaryError("Managed inference is restricted", 403, "inference_restricted");
  }
  if (
    !Number.isSafeInteger(value.inferenceBudgetMicrounits)
    || value.inferenceBudgetMicrounits < 0
    || !Number.isSafeInteger(value.inferencePeriodStartsAt)
    || !Number.isSafeInteger(value.inferencePeriodEndsAt)
    || now < value.inferencePeriodStartsAt
    || now >= value.inferencePeriodEndsAt
  ) {
    throw boundaryError("Managed inference budget period is unavailable", 403, "budget_period_inactive");
  }
  return value;
}

export function parseAbortInput(value: unknown): {
  installationId: string;
  logicalRequestId: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw boundaryError("Managed inference abort input is required", 400, "invalid_abort");
  }
  const input = value as Record<string, unknown>;
  return {
    installationId: parseOpaqueId(input.installationId, "installationId"),
    logicalRequestId: parseOpaqueId(input.logicalRequestId, "logicalRequestId"),
  };
}

export async function requestFingerprint(serialized: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertTextOnly(messages: ManagedInferenceRequest["messages"]): void {
  for (const message of messages) {
    const content = "content" in message ? message.content : undefined;
    if (Array.isArray(content) && content.some((block) => block.type === "image")) {
      throw boundaryError(
        "gsv/default does not accept image or audio input",
        400,
        "unsupported_media",
      );
    }
  }
}

function parseOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw boundaryError(`Managed inference ${field} is invalid`, 400, "invalid_identity");
  }
  return value;
}

function parseOptionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw boundaryError(`Managed inference ${field} is invalid`, 400, "invalid_actor");
  }
  return value;
}

function isReasoning(value: unknown): value is NonNullable<ManagedInferenceRequest["reasoning"]> {
  return value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max";
}

function boundaryError(message: string, status: number, code: string): InferenceBoundaryError {
  return new InferenceBoundaryError(message, status, code);
}
