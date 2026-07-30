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
  error: () => undefined,
};
