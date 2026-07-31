import { errorFields, logWhatsApp } from "./logging";

type BaileysLogger = {
  level: string;
  child(fields: Record<string, unknown>): BaileysLogger;
  trace(value: unknown, message?: string): void;
  debug(value: unknown, message?: string): void;
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
};

export const quietBaileysLogger: BaileysLogger = {
  level: "silent",
  child: () => quietBaileysLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (value, message) => {
    const fields = baileysEncryptionFailureFields(value, message);
    if (fields) {
      logWhatsApp("warn", "baileys_recipient_encryption_failed", fields);
    }
  },
};

export function baileysEncryptionFailureFields(
  value: unknown,
  message?: string,
): Record<string, string | number | boolean | null | undefined> | null {
  if (message !== "Failed to encrypt for recipient") return null;
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const error = record.err ?? record.error ?? value;
  return errorFields(error);
}
