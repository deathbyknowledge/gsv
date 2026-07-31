export type WhatsAppLogLevel = "info" | "warn" | "error";

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

export function errorFields(error: unknown): {
  errorType: string;
  statusCode?: number;
} {
  const statusCode = httpStatusCode(
    nestedNumber(error, ["output", "statusCode"])
    ?? nestedNumber(error, ["statusCode"])
    ?? nestedNumber(error, ["status"]),
  );
  return {
    errorType: allowlistedErrorType(error),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

export function errorMessage(error: unknown): string {
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

function nestedNumber(value: unknown, path: string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : undefined;
}

function httpStatusCode(value: number | undefined): number | undefined {
  return value !== undefined
    && Number.isInteger(value)
    && value >= 100
    && value <= 599
    ? value
    : undefined;
}

function allowlistedErrorType(error: unknown): string {
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof EvalError) return "EvalError";
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof Error) return "Error";
  switch (typeof error) {
    case "bigint":
    case "boolean":
    case "function":
    case "number":
    case "string":
    case "symbol":
    case "undefined":
      return typeof error;
    default:
      return error === null ? "null" : "object";
  }
}
