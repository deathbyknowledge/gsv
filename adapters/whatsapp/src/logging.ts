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
  const statusCode = nestedNumber(error, ["output", "statusCode"])
    ?? nestedNumber(error, ["statusCode"])
    ?? nestedNumber(error, ["status"]);
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url-redacted]")
    .replace(/\b(?:authorization|token|secret|signature|auth|key)=?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:bearer\s+)?[a-z0-9_+/=-]{80,}\b/gi, "[payload-redacted]")
    .replace(/\b(?:\d{5,}|[a-z0-9._-]+@(?:s\.whatsapp\.net|lid|g\.us|hosted(?:\.lid)?))\b/gi, "[redacted]")
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
