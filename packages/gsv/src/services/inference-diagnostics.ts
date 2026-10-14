import * as z from "zod/mini";
import { exceptionDiagnostics, type ExceptionDiagnostics } from "../diagnostics.js";
import { emitTelemetry, inferenceWorkloadSchema, type TelemetryEnvironment, type TelemetryEvent } from "../telemetry.js";

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
export function inferenceErrorMetadata(cause: unknown): Pick<ClientResult, "errorType" | "httpStatus" | "rpcRemote" | "rpcRetryable" | "rpcOverloaded"> & ExceptionDiagnostics {
  const parsed = errorFieldsSchema.safeParse(cause);
  if (!parsed.success) return { errorType: "unknown", ...exceptionDiagnostics(cause) };
  const fields = parsed.data;
  const metadata: ReturnType<typeof inferenceErrorMetadata> = {
    ...exceptionDiagnostics(cause),
    // SAFETY: Membership in the closed set above matches the telemetry enum.
    errorType: fields.name && errorTypes.has(fields.name) ? fields.name as ClientResult["errorType"] : "unknown",
  };
  if (fields.status !== undefined && Number.isInteger(fields.status) && fields.status >= 100 && fields.status <= 599) metadata.httpStatus = fields.status;
  if (fields.remote !== undefined) metadata.rpcRemote = fields.remote;
  if (fields.retryable !== undefined) metadata.rpcRetryable = fields.retryable;
  if (fields.overloaded !== undefined) metadata.rpcOverloaded = fields.overloaded;
  return metadata;
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
