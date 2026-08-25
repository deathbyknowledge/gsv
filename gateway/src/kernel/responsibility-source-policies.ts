import type {
  ResponsibilitySourcePolicy,
  ResponsibilitySourcePolicyId,
} from "@humansandmachines/gsv/protocol";

type PolicyDefinition = Omit<
  ResponsibilitySourcePolicy,
  "enabled" | "updatedAtMs"
>;

const POLICY_DEFINITIONS = [
  {
    id: "mail.received",
    name: "Incoming mail",
    description: "Ask the Ship to review each newly received email.",
    defaultEnabled: true,
  },
] as const satisfies readonly PolicyDefinition[];

type PolicyRow = {
  source_id: string;
  enabled: number;
  updated_at: number;
};

export class ResponsibilitySourcePolicyStore {
  constructor(private readonly sql: SqlStorage) {}

  list(ownerUid: number): ResponsibilitySourcePolicy[] {
    const overrides = new Map(
      this.sql.exec<PolicyRow>(
        `SELECT source_id, enabled, updated_at
           FROM responsibility_source_policies
          WHERE owner_uid = ?`,
        ownerUid,
      ).toArray().map((row) => [row.source_id, row]),
    );
    return POLICY_DEFINITIONS.map((definition) => {
      const override = overrides.get(definition.id);
      return {
        ...definition,
        enabled: override ? override.enabled === 1 : definition.defaultEnabled,
        ...(override ? { updatedAtMs: override.updated_at } : undefined),
      };
    });
  }

  get(ownerUid: number, sourceId: ResponsibilitySourcePolicyId): ResponsibilitySourcePolicy {
    const definition = policyDefinition(sourceId);
    const override = this.sql.exec<PolicyRow>(
      `SELECT source_id, enabled, updated_at
         FROM responsibility_source_policies
        WHERE owner_uid = ? AND source_id = ?
        LIMIT 1`,
      ownerUid,
      sourceId,
    ).toArray()[0];
    return {
      ...definition,
      enabled: override ? override.enabled === 1 : definition.defaultEnabled,
      ...(override ? { updatedAtMs: override.updated_at } : undefined),
    };
  }

  set(
    ownerUid: number,
    sourceId: ResponsibilitySourcePolicyId,
    enabled: boolean,
    now = Date.now(),
  ): ResponsibilitySourcePolicy {
    policyDefinition(sourceId);
    this.sql.exec(
      `INSERT INTO responsibility_source_policies (owner_uid, source_id, enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_uid, source_id) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      ownerUid,
      sourceId,
      enabled ? 1 : 0,
      now,
    );
    return this.get(ownerUid, sourceId);
  }

  isEnabled(ownerUid: number, sourceId: ResponsibilitySourcePolicyId): boolean {
    return this.get(ownerUid, sourceId).enabled;
  }
}

function policyDefinition(sourceId: ResponsibilitySourcePolicyId): PolicyDefinition {
  const definition = POLICY_DEFINITIONS.find((candidate) => candidate.id === sourceId);
  if (!definition) throw new Error(`Unknown responsibility source: ${sourceId}`);
  return definition;
}
