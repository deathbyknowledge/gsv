export function approvalTargetFromValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "any") {
    return undefined;
  }
  if (trimmed === "device" || trimmed === "devices/*") {
    return "targets/*";
  }
  if (trimmed === "gateway" || trimmed === "local") {
    return "gsv";
  }
  return trimmed;
}
