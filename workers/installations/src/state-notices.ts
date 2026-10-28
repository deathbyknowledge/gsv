import type { InstallationAdmissionService } from "@humansandmachines/gsv/services/lifecycle";
import type { PdsModerationService } from "@humansandmachines/gsv/services/pds";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { parseOpaqueId } from "./domain";

/** How long Accounts waits for a follower to answer. */
const DELIVERY_TIMEOUT_MS = 5_000;
/** How many pending notices one cron run retries for each follower, least recently tried first. */
const RETRY_BATCH = 20;

export type InstallationStateNoticeEnvironment = {
  /** The Gateway's admission entrypoint, with deployment-owned props. */
  ADMISSION_GATEWAY?: InstallationAdmissionService;
  /** The deployment's PDS, with the operator's moderation authority. */
  PDS_MODERATION?: PdsModerationService;
};

/** What follows installations' states, each told of every change on its own. */
export type InstallationStateFollowers = {
  /** Has each installation's Kernel keep its state, and answers with the revision the Kernel holds. */
  gateway?: InstallationAdmissionService;
  /** Has each installation's account follow the state, which the PDS reads from Accounts itself. */
  pds?: Pick<PdsModerationService, "reconcileAccountStatus">;
};

/** A follower as a notice tracks it: its columns, and how it is told of a change. */
type Follower = {
  name: string;
  /** The revision the follower has read, and when Accounts last tried to tell it. */
  revision: "gateway_revision" | "pds_revision";
  attemptedAt: "gateway_attempted_at" | "pds_attempted_at";
  /** What the warning says when the follower can't be told. */
  unreached: string;
  /** Tells the follower of the installation's change at `revision`, and resolves with the revision it has read. */
  tell(installationId: string, revision: number): Promise<number>;
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
 * new state takes a higher revision and is pending again for every follower,
 * while an unchanged one leaves the notice as it was. The revision is the
 * change's time in milliseconds, or one more than the last when the clock
 * hasn't moved on, so a change made after restoring the database still
 * outranks whatever a Kernel kept.
 */
function noticeInstallationState(db: D1Database, installationId: string, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO installation_state_notices (installation_id, state, revision)
    SELECT id, state, ? FROM installations WHERE id = ?
    ON CONFLICT (installation_id) DO UPDATE SET state = excluded.state,
      revision = MAX(installation_state_notices.revision + 1, excluded.revision), gateway_attempted_at = 0, pds_attempted_at = 0
    WHERE installation_state_notices.state != excluded.state`).bind(now, installationId);
}

/** The deployment's notices, or none when it binds no follower. */
export function installationStateNotices(db: D1Database, env: InstallationStateNoticeEnvironment): InstallationStateNotices | undefined {
  if (!env.ADMISSION_GATEWAY && !env.PDS_MODERATION) return undefined;
  return new InstallationStateNotices(db, { gateway: env.ADMISSION_GATEWAY, pds: env.PDS_MODERATION });
}

/**
 * Tells what follows each installation's state of the changes recorded in
 * `installation_state_notices`: the Gateway, for the installation's Kernel,
 * and the deployment's PDS. A notice stays pending for each follower until
 * that follower has read its revision or a later one, and the cron retries it
 * until then, so a failed call never loses a change and neither follower
 * waits on the other.
 */
export class InstallationStateNotices {
  private readonly gateway?: Follower;
  private readonly pds?: Follower;

  constructor(
    private readonly db: D1Database,
    followers: InstallationStateFollowers,
    private readonly clock: () => number = Date.now,
  ) {
    const { gateway, pds } = followers;
    if (gateway) {
      this.gateway = {
        name: "Gateway", revision: "gateway_revision", attemptedAt: "gateway_attempted_at",
        unreached: "[Lifecycle] Ship not yet told of its state:",
        async tell(installationId) {
          const result = await gateway.installationStateChanged({ version: 1, installationId });
          if (!result.found) throw new Error("The Gateway's directory does not hold the installation");
          if (!Number.isSafeInteger(result.stateRevision) || result.stateRevision < 0) throw new Error("The Gateway answered with an invalid revision");
          return result.stateRevision;
        },
      };
    }
    if (pds) {
      this.pds = {
        name: "PDS", revision: "pds_revision", attemptedAt: "pds_attempted_at",
        unreached: "[Lifecycle] Open-network host not yet told of a Ship's state:",
        // The PDS reads the state from Accounts once told, so it has read at least the change pending when it was told.
        async tell(installationId, revision) {
          await pds.reconcileAccountStatus(installationId);
          return revision;
        },
      };
    }
  }

  /**
   * Tells each follower of a pending change now, and returns whether the
   * installation's Kernel holds the latest. A follower that can't be told
   * waits for the cron.
   */
  async deliver(installationIdValue: string): Promise<boolean> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const [kernel] = await Promise.all([this.tell(this.gateway, installationId), this.tell(this.pds, installationId)]);
    return kernel;
  }

  /** Retries each follower's pending notices from the cron. */
  async resumePending(): Promise<void> {
    await Promise.all([this.gateway, this.pds].map(async (follower) => {
      if (!follower) return;
      const pending = await this.db.prepare(`SELECT installation_id FROM installation_state_notices
        WHERE ${follower.revision} < revision ORDER BY ${follower.attemptedAt}, installation_id LIMIT ?`)
        .bind(RETRY_BATCH).all<{ installation_id: string }>();
      await Promise.all(pending.results.map(({ installation_id: installationId }) => this.tell(follower, installationId)));
    }));
  }

  /** Tells one follower of the installation's pending change, and returns whether it has read the latest. */
  private async tell(follower: Follower | undefined, installationId: string): Promise<boolean> {
    if (!follower) return true;
    const pending = await this.db.prepare(`SELECT revision FROM installation_state_notices
      WHERE installation_id = ? AND ${follower.revision} < revision`).bind(installationId).first<{ revision: number }>();
    if (!pending) return true;
    const attemptedAt = this.clock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = await Promise.race([
        follower.tell(installationId, pending.revision),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`The ${follower.name} did not answer in time`)), DELIVERY_TIMEOUT_MS);
        }),
      ]);
      await this.db.prepare(`UPDATE installation_state_notices
        SET ${follower.revision} = MAX(${follower.revision}, ?), ${follower.attemptedAt} = ? WHERE installation_id = ?`)
        .bind(read, attemptedAt, installationId).run();
      return read >= pending.revision;
    } catch (error) {
      console.warn(follower.unreached, installationId, exceptionDiagnostics(error));
      await this.db.prepare(`UPDATE installation_state_notices SET ${follower.attemptedAt} = ? WHERE installation_id = ?`)
        .bind(attemptedAt, installationId).run();
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
