import * as z from "zod/mini";
import { emitTelemetry, inferenceWorkloadSchema, type TelemetryEnvironment, type TelemetryEvent } from "../telemetry";

type ClientResult = Extract<TelemetryEvent, { name: "inference.client.finished" }>["properties"];
const diagnosticIdSchema = z.string().check(z.uuid());
const errorFieldsSchema = z.object({
  name: z.optional(z.string()),
  status: z.optional(z.number()),
  remote: z.optional(z.boolean()),
  retryable: z.optional(z.boolean()),
  overloaded: z.optional(z.boolean()),
});
const errorTypes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "TimeoutError", "AggregateError"]);

/** Independent of durable request, Process and run identities; safe to export. */
export function inferenceDiagnosticId(value?: string): string {
  const parsed = diagnosticIdSchema.safeParse(value);
  return parsed.success ? parsed.data : crypto.randomUUID();
}

/** Only explicitly enumerated exception metadata crosses the telemetry boundary. */
export function inferenceErrorMetadata(error: unknown): Pick<ClientResult, "errorType" | "httpStatus" | "rpcRemote" | "rpcRetryable" | "rpcOverloaded"> {
  const parsed = errorFieldsSchema.safeParse(error);
  if (!parsed.success) return { errorType: "unknown" };
  const fields = parsed.data;
  return {
    // SAFETY: Membership in the closed set above matches the telemetry enum.
    errorType: fields.name && errorTypes.has(fields.name) ? fields.name as ClientResult["errorType"] : "unknown",
    ...(typeof fields.status === "number" && Number.isInteger(fields.status) && fields.status >= 100 && fields.status <= 599 ? { httpStatus: fields.status } : {}),
    ...(fields.remote === undefined ? {} : { rpcRemote: fields.remote }),
    ...(fields.retryable === undefined ? {} : { rpcRetryable: fields.retryable }),
    ...(fields.overloaded === undefined ? {} : { rpcOverloaded: fields.overloaded }),
  };
}

export function reportInferenceClientResult(
  env: TelemetryEnvironment | undefined,
  identity: { installationId: string; workload?: string },
  result: Omit<ClientResult, "workload">,
): void {
  emitTelemetry(env, {
    installationId: identity.installationId,
    component: result.boundary === "execution" ? "gateway" : "inference",
    event: {
      stream: "operational", name: "inference.client.finished",
      properties: { ...result, workload: inferenceWorkloadSchema.safeParse(identity.workload).data ?? "unknown" },
    },
  });
}
