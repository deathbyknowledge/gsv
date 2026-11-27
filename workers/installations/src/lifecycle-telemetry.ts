import { emitTelemetry, telemetryEnabled, type InstallationLifecycleEventName, type TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";

/** Reports what became of a Ship under the pseudonym its activation was reported under. */
export function reportInstallationLifecycle(
  telemetry: TelemetryEnvironment | undefined,
  installationId: string,
  name: InstallationLifecycleEventName,
): boolean {
  return emitTelemetry(telemetry, { component: "accounts", installationId, event: { stream: "product", name, properties: {} } });
}

export type InstallationLifecycleReport = { reported: number; next: string | null };

const REPORT_PAGE = 200;

/**
 * Reports the present state of every Ship that is suspended, retired or erased, for the ones whose change
 * happened before these events existed. It reads state rather than history, so repeating it says the same
 * thing again and a reader takes each Ship's latest record. An erased Ship is known only by the deletion
 * record that keeps its installation ID from being reused. One call reports one page; pass `next` back as
 * `after` until it is null.
 */
export async function reportInstallationLifecycleBackfill(
  db: D1Database,
  telemetry: TelemetryEnvironment | undefined,
  after = "",
): Promise<InstallationLifecycleReport> {
  if (!telemetryEnabled(telemetry)) throw new Error("installation telemetry is not enabled");
  const rows = await db.prepare(
    `SELECT id, kind FROM (
       SELECT id, CASE WHEN state = 'restricted' THEN 'restricted' ELSE 'retired' END AS kind FROM installations
       WHERE activated_at IS NOT NULL AND state IN ('restricted', 'retained', 'deleting', 'deleted')
       UNION SELECT installation_id, 'retired' FROM installation_account_deletions
       UNION SELECT installation_id, 'retired' FROM installation_deletions
     ) WHERE id > ? ORDER BY id LIMIT ?`,
  ).bind(after, REPORT_PAGE).all<{ id: string; kind: "restricted" | "retired" }>();
  let reported = 0;
  for (const row of rows.results) {
    if (reportInstallationLifecycle(telemetry, row.id, `installation.${row.kind}`)) reported += 1;
  }
  return { reported, next: rows.results.length === REPORT_PAGE ? rows.results[rows.results.length - 1].id : null };
}
