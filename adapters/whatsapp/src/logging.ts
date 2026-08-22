import { z } from "zod";

export type WhatsAppLogLevel = "info" | "warn" | "error";
type ErrorFields = { errorType: string; statusCode?: number };
const externalErrorSchema = z.unknown();
type ExternalError = Parameters<typeof externalErrorSchema.safeParse>[0];
const errorMetadataSchema = z.looseObject({
  output: z.optional(z.looseObject({ statusCode: z.optional(z.number()) })),
  statusCode: z.optional(z.number()),
  status: z.optional(z.number()),
});
const errorObjectSchema = z.looseObject({});

export function logWhatsApp(
  level: WhatsAppLogLevel,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const payload = JSON.stringify({
    adapter: "whatsapp",
    event,
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ),
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}

export function errorFields(error: ExternalError): ErrorFields {
  const metadata = errorMetadataSchema.safeParse(error);
  const statusCode = httpStatusCode(
    metadata.success
      ? metadata.data.output?.statusCode ?? metadata.data.statusCode ?? metadata.data.status
      : undefined,
  );
  const fields: ErrorFields = { errorType: allowlistedErrorType(error) };
  if (statusCode !== undefined) fields.statusCode = statusCode;
  return fields;
}

export function errorMessage(error: ExternalError): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url-redacted]")
    .replace(
      /\b(authorization|token|secret|signature|auth|(?:private[\s_-]+)?key)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, "bearer [redacted]")
    .replace(/(^|[^a-z0-9_])\+?\d(?:[\s().-]*\d){4,}(?=$|[^a-z0-9_])/gi, "$1[redacted]")
    .replace(
      /(^|[^a-z0-9_])[a-z0-9_+/=-]{32,}(?=$|[^a-z0-9_])/gi,
      "$1[payload-redacted]",
    )
    .replace(/\b(?:[a-z0-9._-]+@(?:s\.whatsapp\.net|lid|g\.us|hosted(?:\.lid)?)|\d{5,})\b/gi, "[redacted]")
    .slice(0, 500);
}

function httpStatusCode(value: number | undefined): number | undefined {
  return value !== undefined
    && Number.isInteger(value)
    && value >= 100
    && value <= 599
    ? value
    : undefined;
}

function allowlistedErrorType(error: ExternalError): string {
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof EvalError) return "EvalError";
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof Error) return "Error";
  if (errorObjectSchema.safeParse(error).success) return "object";
  return error === null ? "null" : "unknown";
}
