/** Canonical BCP 47 language preference; never accept arbitrary prompt text. */
export function normalizeLanguage(value: string): string {
  try {
    const language = new Intl.Locale(value.trim()).baseName;
    if (language !== "und") return language;
  } catch { /* Report the same validation error for invalid language tags. */ }
  throw new Error("language must be a valid BCP 47 language tag, such as es or es-MX");
}
