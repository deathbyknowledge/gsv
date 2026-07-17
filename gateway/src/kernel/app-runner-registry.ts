import { buildAppRunnerName } from "../protocol/app-session";

export type ManagedAppRunnerRecord = {
  runnerName: string;
  uid: number;
  packageId: string;
  createdAt: number;
  updatedAt: number;
};

type ManagedAppRunnerRow = {
  runner_name: string;
  uid: number;
  package_id: string;
  created_at: number;
  updated_at: number;
};

export class AppRunnerRegistry {
  constructor(private readonly sql: SqlStorage) {}

  register(uid: number, packageId: string): ManagedAppRunnerRecord {
    const normalizedPackageId = packageId.trim();
    if (!Number.isSafeInteger(uid) || uid < 0 || !normalizedPackageId) {
      throw new Error("Invalid app runner identity");
    }
    const runnerName = buildAppRunnerName(uid, normalizedPackageId);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO managed_app_runners (
         runner_name, uid, package_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(uid, package_id) DO UPDATE SET
         runner_name = excluded.runner_name,
         updated_at = excluded.updated_at`,
      runnerName,
      uid,
      normalizedPackageId,
      now,
      now,
    );
    return this.get(uid, normalizedPackageId)!;
  }

  get(uid: number, packageId: string): ManagedAppRunnerRecord | null {
    const row = this.sql.exec<ManagedAppRunnerRow>(
      "SELECT * FROM managed_app_runners WHERE uid = ? AND package_id = ?",
      uid,
      packageId,
    ).one();
    return row ? toRecord(row) : null;
  }

  list(): ManagedAppRunnerRecord[] {
    return this.sql.exec<ManagedAppRunnerRow>(
      "SELECT * FROM managed_app_runners ORDER BY uid, package_id",
    ).toArray().map(toRecord);
  }

  remove(runnerName: string): boolean {
    const before = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM managed_app_runners WHERE runner_name = ?",
      runnerName,
    ).one()?.count ?? 0;
    this.sql.exec("DELETE FROM managed_app_runners WHERE runner_name = ?", runnerName);
    return before > 0;
  }
}

function toRecord(row: ManagedAppRunnerRow): ManagedAppRunnerRecord {
  return {
    runnerName: row.runner_name,
    uid: row.uid,
    packageId: row.package_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
