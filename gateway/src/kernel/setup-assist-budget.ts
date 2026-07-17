const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOURLY_REQUEST_LIMIT = 20;
const DAILY_REQUEST_LIMIT = 50;

type SetupAssistUsageRow = {
  hourly_window_started_at: number;
  hourly_requests: number;
  daily_window_started_at: number;
  daily_requests: number;
};

export class SetupAssistRateLimitError extends Error {
  readonly status = 429;

  constructor() {
    super("Setup assistance limit reached; try again later");
    this.name = "SetupAssistRateLimitError";
  }
}

export class SetupAssistBudget {
  constructor(private readonly sql: SqlStorage) {}

  consume(now = Date.now()): void {
    const existing = this.sql.exec<SetupAssistUsageRow>(
      `SELECT hourly_window_started_at, hourly_requests,
              daily_window_started_at, daily_requests
       FROM setup_assist_usage WHERE scope = 1`,
    ).toArray()[0];

    const hourlyWindowStartedAt = resetWindow(
      existing?.hourly_window_started_at,
      now,
      HOURLY_WINDOW_MS,
    );
    const dailyWindowStartedAt = resetWindow(
      existing?.daily_window_started_at,
      now,
      DAILY_WINDOW_MS,
    );
    const hourlyRequests = hourlyWindowStartedAt === existing?.hourly_window_started_at
      ? existing.hourly_requests
      : 0;
    const dailyRequests = dailyWindowStartedAt === existing?.daily_window_started_at
      ? existing.daily_requests
      : 0;

    if (hourlyRequests >= HOURLY_REQUEST_LIMIT || dailyRequests >= DAILY_REQUEST_LIMIT) {
      throw new SetupAssistRateLimitError();
    }

    this.sql.exec(
      `INSERT INTO setup_assist_usage (
         scope, hourly_window_started_at, hourly_requests,
         daily_window_started_at, daily_requests
       ) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         hourly_window_started_at = excluded.hourly_window_started_at,
         hourly_requests = excluded.hourly_requests,
         daily_window_started_at = excluded.daily_window_started_at,
         daily_requests = excluded.daily_requests`,
      hourlyWindowStartedAt,
      hourlyRequests + 1,
      dailyWindowStartedAt,
      dailyRequests + 1,
    );
  }
}

function resetWindow(startedAt: number | undefined, now: number, duration: number): number {
  return startedAt === undefined || now < startedAt || now - startedAt >= duration
    ? now
    : startedAt;
}
