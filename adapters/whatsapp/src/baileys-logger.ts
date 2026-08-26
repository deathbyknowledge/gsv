import { errorFields, logWhatsApp } from "./logging";

type BaileysLogger = {
  level: string;
  child(fields: BaileysLogFields): BaileysLogger;
  trace(value: BaileysLogValue, message?: string): void;
  debug(value: BaileysLogValue, message?: string): void;
  info(value: BaileysLogValue, message?: string): void;
  warn(value: BaileysLogValue, message?: string): void;
  error(value: BaileysLogValue, message?: string): void;
};
type BaileysLogValue = Error | string | number | boolean | null | undefined | BaileysLogFields;
type BaileysLogFields = { [key: string]: BaileysLogValue };

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
  value: BaileysLogValue,
  message?: string,
): Record<string, string | number | boolean | null | undefined> | null {
  if (message !== "Failed to encrypt for recipient") return null;
  const record = isBaileysLogFields(value) ? value : {};
  const error = record.err ?? record.error ?? value;
  return errorFields(error);
}

function isBaileysLogFields(value: BaileysLogValue): value is BaileysLogFields {
  return value !== null
    && value !== undefined
    && !(value instanceof Error)
    && value === Object(value);
}
