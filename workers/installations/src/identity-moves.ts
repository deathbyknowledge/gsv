import {
  operatorIdentityMoveSchema,
  operatorIdentitySurveySchema,
  operatorPersonDidSchema,
  type OperatorGatewayService,
  type OperatorIdentityMove,
  type OperatorIdentitySurvey,
  type OperatorLegacyPerson,
  type OperatorPersonDid,
} from "@humansandmachines/gsv/services/operator";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";

/*
 * The operator's move of every Ship's contacts to DIDs, in two passes over the
 * Ships the directory holds as active or suspended. The survey asks each Ship
 * how other Ships named its person before DIDs and whom its own rows name.
 * Once every Ship has answered, the operator applies the move, and each Ship
 * receives the DIDs of the people it names. Release 2 drops this with the
 * Kernel's legacy rows.
 */

const BATCH = 20;
const CONCURRENCY = 5;
/** How long one attempt may hold its Ship before another job may try it again. */
const LEASE_MS = 10 * 60_000;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const ERROR_MAX_LENGTH = 500;

type IdentityMoveGateway = Pick<OperatorGatewayService, "operatorIdentitySurvey" | "operatorIdentityMove">;
export type IdentityMovePhase = "not-started" | "surveying" | "ready" | "moving" | "moved";
type MovedCounts = OperatorIdentityMove["moved"];

export type IdentityMoveStatus = {
  phase: IdentityMovePhase;
  ships: { total: number; surveyed: number; moved: number };
  /** Everyone the Ships' rows name; someone without a DID here is on another deployment, or their Ship is gone. */
  people: { named: number; withDid: number; withoutDid: number };
  waiting: OperatorIdentitySurvey["waiting"];
  /** Contacts of an account other than a Ship's person, which the move ends. */
  otherAccounts: number;
  moved: MovedCounts;
  ended: MovedCounts;
  /** Ships whose last attempt failed; the job tries each again. */
  retrying: {
    installationId: string; handle: string | null; state: "surveying" | "moving";
    attempts: number; error: string; nextAttemptAt: number | null;
  }[];
};

/** An operator request the move refuses, with the status that says why. */
export class IdentityMoveRefusal extends Error {
  constructor(message: string, readonly status: 400 | 409 | 503) {
    super(message);
  }
}

type Claimed = {
  installation_id: string; state: "surveying" | "moving"; attempts: number;
  ship_id: string | null; subject_id: string | null; did: string | null; handle: string | null; survey_json: string | null;
};

type StatusRow = {
  installation_id: string; state: "surveying" | "surveyed" | "moving" | "moved"; ship_id: string | null; subject_id: string | null;
  did: string | null; survey_json: string | null; move_json: string | null; attempts: number;
  next_attempt_at: number | null; last_error: string | null; ship_handle: string | null;
};

export class IdentityMoves {
  constructor(
    private readonly db: D1Database,
    private readonly gateway: IdentityMoveGateway | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Surveys every Ship the directory holds as active or suspended; until the move is applied, surveying again starts over. */
  async survey(): Promise<IdentityMoveStatus> {
    if (!this.gateway) throw new IdentityMoveRefusal("This deployment doesn't bind the Gateway to Accounts, so Ships can't be surveyed", 503);
    const now = this.clock();
    const notApplied = "NOT EXISTS (SELECT 1 FROM identity_moves WHERE state IN ('moving', 'moved'))";
    const [, , applied] = await this.db.batch<{ count: number }>([
      this.db.prepare(`DELETE FROM identity_moves
        WHERE installation_id NOT IN (SELECT id FROM installations WHERE state IN ('active', 'restricted')) AND ${notApplied}`),
      this.db.prepare(`INSERT INTO identity_moves (installation_id, state, attempts, next_attempt_at, created_at, updated_at)
        SELECT id, 'surveying', 0, ?1, ?1, ?1 FROM installations WHERE state IN ('active', 'restricted') AND ${notApplied}
        ON CONFLICT (installation_id) DO UPDATE SET state = 'surveying', ship_id = NULL, subject_id = NULL, did = NULL, handle = NULL,
          survey_json = NULL, attempts = 0, next_attempt_at = ?1, last_error = NULL, updated_at = ?1`).bind(now),
      this.db.prepare("SELECT COUNT(*) AS count FROM identity_moves WHERE state IN ('moving', 'moved')"),
    ]);
    if (applied?.results[0]?.count) {
      throw new IdentityMoveRefusal("The move has been applied, so the Ships can't be surveyed again", 409);
    }
    return await this.status();
  }

  /** Starts each Ship's move; only once every Ship has answered its survey. */
  async apply(): Promise<IdentityMoveStatus> {
    if ((await this.status()).phase !== "ready") {
      throw new IdentityMoveRefusal("Every Ship must answer its survey before the move", 409);
    }
    const now = this.clock();
    await this.db.prepare(`UPDATE identity_moves SET state = 'moving', attempts = 0, next_attempt_at = ?1, last_error = NULL, updated_at = ?1
      WHERE state = 'surveyed'`).bind(now).run();
    return await this.status();
  }

  /** One pass of the scheduled job: surveys or moves the Ships that are due. */
  async resumePending(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) return;
    const now = this.clock();
    // One statement claims each Ship, so two jobs never try the same one at once.
    const claimed = (await this.db.prepare(`UPDATE identity_moves SET attempts = attempts + 1, next_attempt_at = ?1, updated_at = ?2
      WHERE installation_id IN (
        SELECT installation_id FROM identity_moves WHERE state IN ('surveying', 'moving') AND next_attempt_at <= ?2
        ORDER BY next_attempt_at, installation_id LIMIT ?3)
      RETURNING installation_id, state, attempts, ship_id, subject_id, did, handle, survey_json`)
      .bind(now + LEASE_MS, now, BATCH).all<Claimed>()).results;
    if (claimed.length === 0) return;
    const people = claimed.some((ship) => ship.state === "moving") ? await this.knownPeople() : new Map<string, OperatorPersonDid>();
    for (let index = 0; index < claimed.length; index += CONCURRENCY) {
      await Promise.all(claimed.slice(index, index + CONCURRENCY).map((ship) => this.attempt(ship, gateway, people)));
    }
  }

  async status(): Promise<IdentityMoveStatus> {
    const rows = (await this.db.prepare(`SELECT m.installation_id, m.state, m.ship_id, m.subject_id, m.did, m.survey_json, m.move_json,
        m.attempts, m.next_attempt_at, m.last_error, i.handle AS ship_handle
      FROM identity_moves m LEFT JOIN installations i ON i.id = m.installation_id ORDER BY m.installation_id`).all<StatusRow>()).results;
    const known = new Set(rows.flatMap((row) => row.ship_id && row.subject_id ? [oldName({ shipId: row.ship_id, subjectId: row.subject_id })] : []));
    const named = new Set<string>();
    const waiting = { contacts: 0, blocks: 0, requests: 0, deliveries: 0 };
    let otherAccounts = 0;
    const moved = noRows();
    const ended = noRows();
    for (const row of rows) {
      if (row.survey_json) {
        const survey = operatorIdentitySurveySchema.parse(JSON.parse(row.survey_json));
        for (const reference of survey.references) named.add(oldName(reference));
        addCounts(waiting, survey.waiting);
        otherAccounts += survey.otherAccounts;
      }
      if (row.move_json) {
        const move = operatorIdentityMoveSchema.parse(JSON.parse(row.move_json));
        addCounts(moved, move.moved);
        addCounts(ended, move.ended);
      }
    }
    const withDid = [...named].filter((name) => known.has(name)).length;
    return {
      phase: phaseOf(rows.map((row) => row.state)),
      ships: {
        total: rows.length,
        surveyed: rows.filter((row) => row.state !== "surveying").length,
        moved: rows.filter((row) => row.state === "moved").length,
      },
      people: { named: named.size, withDid, withoutDid: named.size - withDid },
      waiting,
      otherAccounts,
      moved,
      ended,
      retrying: rows.flatMap((row) => row.last_error && (row.state === "surveying" || row.state === "moving") ? [{
        installationId: row.installation_id, handle: row.ship_handle, state: row.state,
        attempts: row.attempts, error: row.last_error, nextAttemptAt: row.next_attempt_at,
      }] : []),
    };
  }

  private async attempt(ship: Claimed, gateway: IdentityMoveGateway, people: ReadonlyMap<string, OperatorPersonDid>): Promise<void> {
    try {
      if (ship.state === "surveying") await this.recordSurvey(ship, gateway);
      else await this.recordMove(ship, gateway, people);
    } catch (error) {
      const now = this.clock();
      const retryAt = now + RETRY_MS[Math.min(ship.attempts, RETRY_MS.length) - 1]!;
      const diagnostics = exceptionDiagnostics(error);
      // The page shows the redacted message, bounded; the Worker's diagnostics keep the rest.
      const message = (diagnostics.exceptionMessage || "The attempt failed").slice(0, ERROR_MAX_LENGTH);
      await this.db.prepare("UPDATE identity_moves SET next_attempt_at = ?, last_error = ?, updated_at = ? WHERE installation_id = ? AND state = ?")
        .bind(retryAt, message, now, ship.installation_id, ship.state).run();
      console.warn("[Operator] Identity move attempt failed:", ship.installation_id, ship.state, diagnostics);
    }
  }

  private async recordSurvey(ship: Claimed, gateway: IdentityMoveGateway): Promise<void> {
    const result = await gateway.operatorIdentitySurvey({ version: 1, installationId: ship.installation_id });
    if (!result.found) {
      // The directory no longer holds the Ship as active or suspended, so it has nothing to move.
      await this.db.prepare("DELETE FROM identity_moves WHERE installation_id = ? AND state = 'surveying'").bind(ship.installation_id).run();
      return;
    }
    const survey = operatorIdentitySurveySchema.parse(result.survey);
    if (survey.installationId !== ship.installation_id) throw new Error("The survey answered for another Ship");
    const person = survey.person;
    await this.db.prepare(`UPDATE identity_moves SET state = 'surveyed', ship_id = ?, subject_id = ?, did = ?, handle = ?,
        survey_json = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ?
      WHERE installation_id = ? AND state = 'surveying'`)
      .bind(person?.shipId ?? null, person?.subjectId ?? null, person?.did ?? null, person?.handle ?? null,
        JSON.stringify(survey), this.clock(), ship.installation_id).run();
  }

  private async recordMove(ship: Claimed, gateway: IdentityMoveGateway, people: ReadonlyMap<string, OperatorPersonDid>): Promise<void> {
    if (!ship.survey_json) throw new Error("The Ship has no survey to move from");
    const survey = operatorIdentitySurveySchema.parse(JSON.parse(ship.survey_json));
    const own = ship.did && ship.ship_id && ship.subject_id
      ? operatorPersonDidSchema.parse({ shipId: ship.ship_id, subjectId: ship.subject_id, did: ship.did, ...(ship.handle ? { handle: ship.handle } : undefined) })
      : null;
    const named = survey.references.flatMap((reference) => people.get(oldName(reference)) ?? []);
    const result = await gateway.operatorIdentityMove({
      version: 1, installationId: ship.installation_id, people: own ? [own, ...named] : named,
    });
    let move: OperatorIdentityMove | null = null;
    if (result.found) {
      move = operatorIdentityMoveSchema.parse(result.move);
      if (move.installationId !== ship.installation_id) throw new Error("The move answered for another Ship");
    }
    // A Ship the directory no longer holds as active or suspended has nothing left to move.
    await this.db.prepare(`UPDATE identity_moves SET state = 'moved', move_json = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ?
      WHERE installation_id = ? AND state = 'moving'`)
      .bind(move ? JSON.stringify(move) : null, this.clock(), ship.installation_id).run();
  }

  /** Each surveyed Ship's person, by how other Ships named them before DIDs. */
  private async knownPeople(): Promise<Map<string, OperatorPersonDid>> {
    const rows = (await this.db.prepare("SELECT ship_id, subject_id, did, handle FROM identity_moves WHERE did IS NOT NULL")
      .all<{ ship_id: string; subject_id: string; did: string; handle: string | null }>()).results;
    return new Map(rows.map((row) => {
      const person = operatorPersonDidSchema.parse({
        shipId: row.ship_id, subjectId: row.subject_id, did: row.did, ...(row.handle ? { handle: row.handle } : undefined),
      });
      return [oldName(person), person];
    }));
  }
}

function phaseOf(states: StatusRow["state"][]): IdentityMovePhase {
  if (states.length === 0) return "not-started";
  if (states.every((state) => state === "moved")) return "moved";
  if (states.some((state) => state === "moving" || state === "moved")) return "moving";
  if (states.some((state) => state === "surveying")) return "surveying";
  return "ready";
}

function oldName(person: OperatorLegacyPerson): string {
  return `${person.shipId} ${person.subjectId}`;
}

function noRows(): MovedCounts {
  return { contacts: 0, blocks: 0, requests: 0, deliveries: 0, messages: 0 };
}

function addCounts(total: Record<string, number>, more: Record<string, number>): void {
  for (const [key, value] of Object.entries(more)) total[key] = (total[key] ?? 0) + value;
}
