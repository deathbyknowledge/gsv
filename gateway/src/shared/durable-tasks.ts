import { z } from "zod";

export type DurableTaskRetry = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type DurableTaskOptions = {
  idempotent?: boolean;
  retry?: DurableTaskRetry;
};

export type DurableTaskSpec = {
  callback: string;
  payload: object | string | number | boolean | null;
};

export type DurableTask<Spec extends DurableTaskSpec = DurableTaskSpec> = Spec & {
  id: string;
  retry?: DurableTaskRetry;
  type: "scheduled" | "delayed";
  time: number;
  delayInSeconds?: number;
};

type DurableTaskRow = {
  id: string;
  callback: string;
  payload: string;
  type: "scheduled" | "delayed";
  time: number;
  delayInSeconds: number | null;
  retry_options: string | null;
};

const DEFAULT_RETRY: DurableTaskRetry = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3_000,
};

const DURABLE_TASK_RETRY_SCHEMA = z.object({
  maxAttempts: z.number().int().positive(),
  baseDelayMs: z.number().nonnegative(),
  maxDelayMs: z.number().nonnegative(),
}).refine(
  (retry) => retry.maxDelayMs >= retry.baseDelayMs,
  { message: "retry.maxDelayMs must be at least retry.baseDelayMs" },
);

const PLATFORM_ERROR_SCHEMA = z.union([
  z.string().transform((message) => ({ message })),
  z.object({
    message: z.string().optional(),
    retryable: z.boolean().optional(),
    overloaded: z.boolean().optional(),
    cause: z.unknown().optional(),
  }),
]);

type PlatformFailureKind = "code-update" | "transient";

const CODE_UPDATE_PATTERN = /reset because its code was updated|this script has been upgraded/i;
const CONNECTION_LOST_PATTERN = /network connection lost/i;

export class DurableTaskScheduler<Spec extends DurableTaskSpec> {
  private alarmUpdate: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly decode: (callback: string, payloadJson: string) => Spec,
    private readonly invoke: (task: DurableTask<Spec>) => Promise<void>,
  ) {}

  async schedule(
    when: Date | number,
    spec: Spec,
    options: DurableTaskOptions = {},
  ): Promise<DurableTask<Spec>> {
    const task = normalizeTaskInput(when, spec, options);
    if (options.idempotent) {
      const existing = this.findIdempotentTask(task);
      if (existing) {
        await this.updateAlarm();
        return existing;
      }
    }

    this.storage.sql.exec(
      `INSERT INTO cf_agents_schedules (
        id, callback, payload, type, time, delayInSeconds, retry_options,
        owner_path, owner_path_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      task.id,
      task.callback,
      JSON.stringify(task.payload),
      task.type,
      task.time,
      task.delayInSeconds ?? null,
      task.retry ? JSON.stringify(task.retry) : null,
    );
    await this.updateAlarm();
    return task;
  }

  async cancel(id: string): Promise<boolean> {
    const result = this.storage.sql.exec(
      "DELETE FROM cf_agents_schedules WHERE id = ? AND owner_path_key IS NULL",
      id,
    );
    await this.updateAlarm();
    return result.rowsWritten > 0;
  }

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    const due = this.storage.sql.exec<DurableTaskRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, retry_options
       FROM cf_agents_schedules
       WHERE time <= ? AND owner_path_key IS NULL
       ORDER BY time ASC, created_at ASC, id ASC`,
      now,
    ).toArray();

    for (const row of due) {
      const stillPending = this.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_schedules WHERE id = ? AND owner_path_key IS NULL",
        row.id,
      ).toArray()[0];
      if (!stillPending) continue;

      const task = taskFromRow(row, this.decode);
      await this.invokeWithRetry(task);
      this.storage.sql.exec(
        "DELETE FROM cf_agents_schedules WHERE id = ? AND owner_path_key IS NULL",
        task.id,
      );
    }
    await this.updateAlarm();
  }

  private findIdempotentTask(task: DurableTask<Spec>): DurableTask<Spec> | null {
    const rows = this.storage.sql.exec<DurableTaskRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, retry_options
       FROM cf_agents_schedules
       WHERE type = ? AND callback = ? AND payload IS ? AND owner_path_key IS NULL
       LIMIT 1`,
      task.type,
      task.callback,
      JSON.stringify(task.payload),
    ).toArray();
    return rows[0] ? taskFromRow(rows[0], this.decode) : null;
  }

  private async invokeWithRetry(task: DurableTask<Spec>): Promise<void> {
    const retry = task.retry ?? DEFAULT_RETRY;
    let lastError: unknown;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      try {
        await this.invoke(task);
        return;
      } catch (error) {
        lastError = error;
        if (platformFailureKind(error) === "code-update") {
          throw error;
        }
        if (attempt < retry.maxAttempts) {
          const delay = Math.min(
            retry.maxDelayMs,
            retry.baseDelayMs * (2 ** (attempt - 1)),
          );
          await wait(delay);
        }
      }
    }
    if (platformFailureKind(lastError)) {
      throw lastError;
    }
    console.error(
      `[DurableTaskScheduler] ${task.callback} failed after ${retry.maxAttempts} attempts`,
      lastError,
    );
  }

  private updateAlarm(): Promise<void> {
    const update = this.alarmUpdate.then(async () => {
      const next = this.storage.sql.exec<{ time: number }>(
        `SELECT time FROM cf_agents_schedules
         WHERE owner_path_key IS NULL
         ORDER BY time ASC
         LIMIT 1`,
      ).toArray()[0];
      if (!next) {
        await this.storage.deleteAlarm();
        return;
      }
      await this.storage.setAlarm(Math.max(next.time * 1_000, Date.now() + 1));
    });
    this.alarmUpdate = update.catch(() => {});
    return update;
  }
}

function normalizeTaskInput<Spec extends DurableTaskSpec>(
  when: Date | number,
  spec: Spec,
  options: DurableTaskOptions,
): DurableTask<Spec> {
  if (!spec.callback) throw new Error("Scheduled callback is required");
  if (options.retry) validateRetry(options.retry);

  if (when instanceof Date) {
    if (!Number.isFinite(when.getTime())) throw new Error("Scheduled time is invalid");
    return {
      id: crypto.randomUUID(),
      ...spec,
      retry: options.retry,
      type: "scheduled",
      time: Math.floor(when.getTime() / 1_000),
    };
  }
  if (!Number.isFinite(when) || when < 0) {
    throw new Error("Scheduled delay must be a non-negative number");
  }
  return {
    id: crypto.randomUUID(),
    ...spec,
    retry: options.retry,
    type: "delayed",
    time: Math.floor((Date.now() + when * 1_000) / 1_000),
    delayInSeconds: when,
  };
}

function validateRetry(retry: DurableTaskRetry): void {
  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw new Error("retry.maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0) {
    throw new Error("retry.baseDelayMs must be non-negative");
  }
  if (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < retry.baseDelayMs) {
    throw new Error("retry.maxDelayMs must be at least retry.baseDelayMs");
  }
}

function taskFromRow<Spec extends DurableTaskSpec>(
  row: DurableTaskRow,
  decode: (callback: string, payloadJson: string) => Spec,
): DurableTask<Spec> {
  const retry = row.retry_options
    ? DURABLE_TASK_RETRY_SCHEMA.parse(JSON.parse(row.retry_options))
    : undefined;
  const task: DurableTask<Spec> = {
    ...decode(row.callback, row.payload),
    id: row.id,
    retry,
    type: row.type,
    time: row.time,
  };
  if (row.type === "delayed") {
    task.delayInSeconds = row.delayInSeconds ?? 0;
  }
  return task;
}

function platformFailureKind(cause: unknown): PlatformFailureKind | null {
  let current = cause;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    const parsed = PLATFORM_ERROR_SCHEMA.safeParse(current);
    if (!parsed.success) return null;
    const message = parsed.data.message ?? "";
    if (CODE_UPDATE_PATTERN.test(message)) return "code-update";
    if (CONNECTION_LOST_PATTERN.test(message)) return "transient";
    if (
      "retryable" in parsed.data
      && parsed.data.retryable
      && !parsed.data.overloaded
      && !message.includes("Durable Object is overloaded")
    ) {
      return "transient";
    }
    current = "cause" in parsed.data ? parsed.data.cause : undefined;
  }
  return null;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
