import type { JsonObject } from "../json";

export type ResponsibilityState =
  | "open"
  | "active"
  | "waiting"
  | "resolved"
  | "cancelled";

export type ResponsibilityPriority = "low" | "normal" | "high" | "critical";

export type ResponsibilityRequiredSourcePolicyId =
  | "interaction.response"
  | "process.delegation"
  | "schedule.due";

export type ResponsibilityConfigurableSourcePolicyId =
  | "mail.received"
  | "federation.received"
  | "contact.added"
  | "machine.added"
  | "adapter.connected"
  | "adapter.auth_required";

export type ResponsibilitySourcePolicyId =
  | ResponsibilityRequiredSourcePolicyId
  | ResponsibilityConfigurableSourcePolicyId;

export type ResponsibilitySourcePolicy =
  | {
      id: ResponsibilityRequiredSourcePolicyId;
      name: string;
      description: string;
      control: "required";
      enabled: true;
      defaultEnabled: true;
    }
  | {
      id: ResponsibilityConfigurableSourcePolicyId;
      name: string;
      description: string;
      control: "configurable";
      enabled: boolean;
      defaultEnabled: boolean;
      updatedAtMs?: number;
    };

export type ResponsibilitySourceListArgs = Record<string, never>;

export type ResponsibilitySourceListResult = {
  sources: ResponsibilitySourcePolicy[];
};

export type ResponsibilitySourceUpdateArgs = {
  id: ResponsibilityConfigurableSourcePolicyId;
  enabled: boolean;
};

export type ResponsibilitySourceUpdateResult = {
  source: ResponsibilitySourcePolicy;
};

export type ResponsibilityAssignee =
  | { kind: "ship" }
  | { kind: "process"; processId: string };

export type ResponsibilityAudience = {
  conversationIds: string[];
};

export type ResponsibilitySource =
  | { kind: "account"; uid: number; username: string }
  | { kind: "process"; processId: string; runId?: string }
  | { kind: "event"; eventType: string; eventId: string }
  | { kind: "schedule"; scheduleId: string }
  | { kind: "system"; component: string };

export type ResponsibilityRecord = {
  id: string;
  ownerUid: number;
  parentId?: string;
  title: string;
  details?: JsonObject;
  source: ResponsibilitySource;
  audience?: ResponsibilityAudience;
  assignee: ResponsibilityAssignee;
  state: ResponsibilityState;
  priority: ResponsibilityPriority;
  dueAtMs?: number;
  nextCheckAtMs?: number;
  blocker?: string;
  leaseExpiresAtMs?: number;
  dedupeKey?: string;
  resolution?: JsonObject;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  resolvedAtMs?: number;
};

export type ResponsibilityTransition = {
  revision: number;
  responsibilityId: string;
  kind: "created" | "updated" | "resolved" | "cancelled";
  beforeState?: ResponsibilityState;
  afterState: ResponsibilityState;
  changedFields: string[];
  actor: ResponsibilitySource;
  record: ResponsibilityRecord;
  createdAtMs: number;
};

export type ResponsibilityListArgs = {
  ids?: string[];
  states?: ResponsibilityState[];
  assigneeProcessId?: string;
  parentId?: string;
  includeTerminal?: boolean;
  limit?: number;
  offset?: number;
};

export type ResponsibilityListResult = {
  responsibilities: ResponsibilityRecord[];
  count: number;
  revision: number;
};

export type ResponsibilityGetArgs = {
  id: string;
};

export type ResponsibilityGetResult = {
  responsibility: ResponsibilityRecord;
  revision: number;
};

export type ResponsibilityCreateArgs = {
  title: string;
  details?: JsonObject;
  parentId?: string;
  audience?: ResponsibilityAudience;
  assignee?: ResponsibilityAssignee;
  priority?: ResponsibilityPriority;
  dueAtMs?: number;
  nextCheckAtMs?: number;
  blocker?: string;
  leaseExpiresAtMs?: number;
  dedupeKey?: string;
};

export type ResponsibilityCreateResult = {
  responsibility: ResponsibilityRecord;
  created: boolean;
  revision: number;
};

export type ResponsibilityPatch = {
  title?: string;
  details?: JsonObject | null;
  parentId?: string | null;
  audience?: ResponsibilityAudience | null;
  assignee?: ResponsibilityAssignee;
  state?: ResponsibilityState;
  priority?: ResponsibilityPriority;
  dueAtMs?: number | null;
  nextCheckAtMs?: number | null;
  blocker?: string | null;
  leaseExpiresAtMs?: number | null;
  resolution?: JsonObject | null;
};

export type ResponsibilityUpdateArgs = {
  id: string;
  expectedRevision?: number;
  patch: ResponsibilityPatch;
};

export type ResponsibilityUpdateResult = {
  responsibility: ResponsibilityRecord;
  revision: number;
};

export type ResponsibilityChangesArgs = {
  afterRevision: number;
  limit?: number;
};

export type ResponsibilityChangesResult = {
  transitions: ResponsibilityTransition[];
  revision: number;
  hasMore: boolean;
};

export function responsibilityRequiresAction(
  responsibility: Pick<
    ResponsibilityRecord,
    "assignee" | "state" | "dueAtMs" | "nextCheckAtMs" | "blocker" | "leaseExpiresAtMs"
  >,
  now: number,
): boolean {
  if (responsibility.state === "resolved" || responsibility.state === "cancelled") {
    return false;
  }
  const deadlineExpired = responsibility.dueAtMs !== undefined
    && responsibility.dueAtMs <= now;
  const leaseExpired = responsibility.leaseExpiresAtMs !== undefined
    && responsibility.leaseExpiresAtMs <= now;
  if (responsibility.assignee.kind === "process") {
    const hasFutureWake = (
      responsibility.leaseExpiresAtMs !== undefined
      && !leaseExpired
    ) || (
      responsibility.dueAtMs !== undefined
      && !deadlineExpired
    ) || (
      responsibility.nextCheckAtMs !== undefined
      && responsibility.nextCheckAtMs > now
    );
    const explicitlyBlocked = responsibility.state === "waiting"
      && !deadlineExpired
      && !leaseExpired
      && Boolean(responsibility.blocker?.trim());
    return !(
      (responsibility.state === "active" || responsibility.state === "waiting")
      && (hasFutureWake || explicitlyBlocked)
    );
  }
  if (
    responsibility.state === "waiting"
    && (
      Boolean(responsibility.blocker?.trim())
      || (responsibility.nextCheckAtMs !== undefined && responsibility.nextCheckAtMs > now)
    )
  ) {
    return false;
  }
  return true;
}
