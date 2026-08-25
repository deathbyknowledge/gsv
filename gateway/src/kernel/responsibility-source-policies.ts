import type {
  ResponsibilityConfigurableSourcePolicyId,
  ResponsibilitySourcePolicy,
  ResponsibilitySourcePolicyId,
} from "@humansandmachines/gsv/protocol";

type PolicyDefinition =
  | {
      id: Exclude<ResponsibilitySourcePolicyId, ResponsibilityConfigurableSourcePolicyId>;
      name: string;
      description: string;
      control: "required";
      defaultEnabled: true;
    }
  | {
      id: ResponsibilityConfigurableSourcePolicyId;
      name: string;
      description: string;
      control: "configurable";
      defaultEnabled: boolean;
    };

const POLICY_DEFINITIONS = [
  {
    id: "interaction.response",
    name: "Conversation replies",
    description: "Keep a direct interaction active until Ship sends a Message or explicitly chooses silence.",
    control: "required",
    defaultEnabled: true,
  },
  {
    id: "process.delegation",
    name: "Delegated work",
    description: "Return assigned work to Ship when its Process completes, fails, times out, or is terminated.",
    control: "required",
    defaultEnabled: true,
  },
  {
    id: "schedule.due",
    name: "Scheduled responsibilities",
    description: "Create one responsibility for every occurrence of an enabled Ship schedule.",
    control: "required",
    defaultEnabled: true,
  },
  {
    id: "mail.received",
    name: "Incoming mail",
    description: "Ask the Ship to review each newly received email.",
    control: "configurable",
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
      if (definition.control === "required") {
        return {
          ...definition,
          enabled: true,
        };
      }
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
    if (definition.control === "required") {
      return {
        ...definition,
        enabled: true,
      };
    }
    return {
      ...definition,
      enabled: override ? override.enabled === 1 : definition.defaultEnabled,
      ...(override ? { updatedAtMs: override.updated_at } : undefined),
    };
  }

  set(
    ownerUid: number,
    sourceId: ResponsibilityConfigurableSourcePolicyId,
    enabled: boolean,
    now = Date.now(),
  ): ResponsibilitySourcePolicy {
    const definition = policyDefinition(sourceId);
    if (definition.control !== "configurable") {
      throw new Error(`Responsibility source is always on: ${sourceId}`);
    }
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

  isEnabled(ownerUid: number, sourceId: ResponsibilityConfigurableSourcePolicyId): boolean {
    return this.get(ownerUid, sourceId).enabled;
  }
}

function policyDefinition(sourceId: ResponsibilitySourcePolicyId): PolicyDefinition {
  const definition = POLICY_DEFINITIONS.find((candidate) => candidate.id === sourceId);
  if (!definition) throw new Error(`Unknown responsibility source: ${sourceId}`);
  return definition;
}
