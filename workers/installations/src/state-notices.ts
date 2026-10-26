import type { InstallationAdmissionService } from "@humansandmachines/gsv/services/lifecycle";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { parseOpaqueId } from "./domain";

/** How long Accounts waits for the Gateway to say the Kernel read a change. */
const DELIVERY_TIMEOUT_MS = 5_000;
/** How many pending notices one cron run retries, least recently tried first. */
const RETRY_BATCH = 20;

export type InstallationStateNoticeEnvironment = {
  /** The Gateway's admission entrypoint, with deployment-owned props. */
  ADMISSION_GATEWAY?: InstallationAdmissionService;
};

/**
 * Runs one batch that changes an installation's state, with the change's
 * notice after its statements, and returns the statements' own results.
 * Every write of an installation's state goes through this, so none goes
 * untold; a test refuses any other.
 */
export async function changeInstallationState(
  db: D1Database,
  installationId: string,
  statements: D1PreparedStatement[],
  now = Date.now(),
): Promise<D1Result[]> {
  const results = await db.batch([...statements, noticeInstallationState(db, installationId, now)]);
  return results.slice(0, statements.length);
}

/**
 * Brings an installation's notice in line with the state its batch left: a
 * new state takes a higher revision and is pending again, while an unchanged
 * one leaves the notice as it was. The revision is the change's time in
 * milliseconds, or one more than the last when the clock hasn't moved on, so
 * a change made after restoring the database still outranks whatever a
 * Kernel kept.
 */
function noticeInstallationState(db: D1Database, installationId: string, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO installation_state_notices (installation_id, state, revision)
    SELECT id, state, ? FROM installations WHERE id = ?
    ON CONFLICT (installation_id) DO UPDATE SET state = excluded.state,
      revision = MAX(installation_state_notices.revision + 1, excluded.revision), attempted_at = 0
    WHERE installation_state_notices.state != excluded.state`).bind(now, installationId);
}

/**
 * Tells each installation's Kernel of the changes of state recorded in
 * `installation_state_notices`. A notice stays pending until the
 * Gateway answers with its revision or a later one, and the cron retries it
 * until then, so a failed call never loses a change.
 */
export class InstallationStateNotices {
  constructor(
    private readonly db: D1Database,
    private readonly gateway: InstallationAdmissionService,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Tells the Kernel of a pending change now, and returns whether it holds the latest; a failure waits for the cron. */
  async deliver(installationIdValue: string): Promise<boolean> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const pending = await this.db.prepare(`SELECT revision FROM installation_state_notices
      WHERE installation_id = ? AND delivered_revision < revision`).bind(installationId).first<{ revision: number }>();
    if (!pending) return true;
    const attemptedAt = this.clock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.gateway.installationStateChanged({ version: 1, installationId }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The Gateway did not answer in time")), DELIVERY_TIMEOUT_MS);
        }),
      ]);
      if (!result.found) throw new Error("The Gateway's directory does not hold the installation");
      if (!Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0) throw new Error("The Gateway answered with an invalid revision");
      await this.db.prepare(`UPDATE installation_state_notices
        SET delivered_revision = MAX(delivered_revision, ?), attempted_at = ? WHERE installation_id = ?`)
        .bind(result.stateRevision, attemptedAt, installationId).run();
      return result.stateRevision >= pending.revision;
    } catch (error) {
      console.warn("[Lifecycle] Ship not yet told of its state:", installationId, exceptionDiagnostics(error));
      await this.db.prepare("UPDATE installation_state_notices SET attempted_at = ? WHERE installation_id = ?")
        .bind(attemptedAt, installationId).run();
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Retries pending notices from the cron. */
  async resumePending(): Promise<void> {
    const pending = await this.db.prepare(`SELECT installation_id FROM installation_state_notices
      WHERE delivered_revision < revision ORDER BY attempted_at, installation_id LIMIT ?`)
      .bind(RETRY_BATCH).all<{ installation_id: string }>();
    await Promise.all(pending.results.map(({ installation_id: installationId }) => this.deliver(installationId)));
  }
}
