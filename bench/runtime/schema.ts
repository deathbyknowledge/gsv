import type {
  JsonObject,
  JsonValue,
  ResponsibilityRecord,
  ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import type { ContextProjection } from "../../workers/gateway/src/process/context/projection";

export type SyntheticTargetKind =
  | "laptop"
  | "server"
  | "browser"
  | "slack";

export type SyntheticProcessSpec = {
  id: string;
  role: "ship" | "worker";
  uid: number;
  ownerUid?: number;
  username?: string;
  gids: number[];
  capabilities: string[];
};

export type SyntheticDelegateSpec = {
  account: string;
  process: SyntheticProcessSpec & { role: "worker" };
  systemPrompt: string;
  maxTurns: number;
};

export type SyntheticAdapterSpec = {
  id: string;
  kind: "slack";
  accountId: string;
  ownerUid: number;
  connected: boolean;
};

export type SyntheticAdapterRouteSpec = {
  adapterId: string;
  accountId: string;
  actorId: string;
  surface: {
    kind: "dm" | "channel";
    id: string;
    threadId?: string;
  };
  inboundDeliveryId: string;
  messageId: string;
};

export type SyntheticTargetEffect =
  | { type: "state.set"; key: string; value: JsonValue }
  | { type: "file.write"; path: string; content: string }
  | { type: "file.delete"; path: string };

export type SyntheticCommandSpec = {
  output: string;
  exitCode?: number;
  effects?: SyntheticTargetEffect[];
};

export type SyntheticTargetSpec = {
  id: string;
  kind: SyntheticTargetKind;
  ownerUid: number;
  accessGids: number[];
  label?: string;
  description?: string;
  platform?: string;
  version?: string;
  online: boolean;
  implements?: string[];
  files?: Record<string, string>;
  state?: JsonObject;
  commands?: Record<string, SyntheticCommandSpec>;
};

export type SyntheticTransitionEffect =
  | { type: "target.online"; targetId: string; online: boolean }
  | { type: "target.access.grant"; targetId: string; gid: number }
  | { type: "target.access.revoke"; targetId: string; gid: number }
  | {
    type: "target.state.set";
    targetId: string;
    key: string;
    value: JsonValue;
  }
  | {
    type: "target.file.write";
    targetId: string;
    path: string;
    content: string;
  };

export type SyntheticTransitionSpec = {
  id: string;
  after: {
    processId: string;
    tool: string;
    arguments?: JsonObject;
    outcome?: "success" | "error" | "any";
  };
  effects: SyntheticTransitionEffect[];
};

export type SyntheticExternalEventSpec = {
  id: string;
  processId: string;
  delayMs: number;
  content: string;
  when?: JsonObject;
  effects?: SyntheticTransitionEffect[];
  evictProcess?: boolean;
};

export type SyntheticWorldSpec = {
  runtime: {
    now: string;
    timezone: string;
  };
  processes: SyntheticProcessSpec[];
  delegates?: SyntheticDelegateSpec[];
  targets: SyntheticTargetSpec[];
  adapters?: SyntheticAdapterSpec[];
};

export type GsvRubricCriterion = {
  id: string;
  description: string;
  weight: number;
  expected: JsonObject;
  assertions?: GsvRubricAssertion[];
};

export type GsvRubricAssertion =
  | {
    type: "log_count";
    entry: JsonObject;
    min?: number;
    max?: number;
  }
  | {
    type: "log_order";
    before: JsonObject;
    after: JsonObject;
  };

export type GsvSemanticLogEntry =
  | {
    type: "tool.call";
    processId: string;
    name: string;
    arguments: JsonObject;
  }
  | {
    type: "tool.result";
    processId: string;
    name: string;
    content: string;
    isError: boolean;
  }
  | { type: "world.transition"; id: string }
  | { type: "context.delta"; processId: string; content: string }
  | {
    type: "responsibility.transition";
    transition: ResponsibilityTransition;
  }
  | {
    type: "process.spawned";
    processId: string;
    parentProcessId: string;
    account: string;
  }
  | {
    type: "ipc.completed";
    callId: string;
    sourceProcessId: string;
    targetProcessId: string;
    resultText?: string;
    error?: string;
  }
  | {
    type: "adapter.sent";
    adapterId: string;
    deliveryId: string;
    processId: string;
    text: string;
  }
  | { type: "run.started"; processId: string; run: number }
  | {
    type: "external.event";
    id: string;
    processId: string;
    atMs: number;
  }
  | { type: "process.evicted"; processId: string; afterRun: number }
  | { type: "message.committed"; processId: string; text: string }
  | { type: "run.yielded"; processId: string }
  | { type: "run.returned"; processId: string; text: string };

export type GsvSurfaceScenario = {
  schemaVersion: 2;
  id: string;
  description: string;
  systemPrompt: string;
  prompt: string;
  entryProcessId: string;
  entryRoute?: SyntheticAdapterRouteSpec;
  world: SyntheticWorldSpec;
  transitions: SyntheticTransitionSpec[];
  externalEvents: SyntheticExternalEventSpec[];
  expected: JsonObject;
  rubric: GsvRubricCriterion[];
  expectedLog?: GsvSemanticLogEntry[];
  maxTurns: number;
  maxRuns: number;
};

export type GsvSurfaceObservation = {
  run: number;
  turn: number;
  processId: string;
  systemPromptSha256: string;
  projection: ContextProjection;
  messageCount: number;
  toolNames: string[];
};

export type SyntheticTargetSnapshot = {
  id: string;
  kind: SyntheticTargetKind;
  ownerUid: number;
  accessGids: number[];
  label: string;
  description: string;
  platform: string;
  version: string;
  online: boolean;
  implements: string[];
  files: Record<string, string>;
  state: JsonObject;
};

export type SyntheticProcessSnapshot = {
  id: string;
  role: "ship" | "worker";
  uid: number;
  ownerUid: number;
  username: string;
  gids: number[];
  capabilities: string[];
  visibleTargets: string[];
  state: "idle" | "running" | "returned" | "failed";
  parentProcessId?: string;
};

export type SyntheticAdapterDeliverySnapshot = {
  deliveryId: string;
  processId: string;
  surface: SyntheticAdapterRouteSpec["surface"];
  text: string;
  replyToId?: string;
  state: "sent";
};

export type SyntheticAdapterSnapshot = SyntheticAdapterSpec & {
  inboundReceipts: Array<{
    deliveryId: string;
    processId: string;
    messageId: string;
  }>;
  deliveries: SyntheticAdapterDeliverySnapshot[];
};

export type SyntheticDelegationSnapshot = {
  callId: string;
  runId: string;
  sourceProcessId: string;
  targetProcessId: string;
  responsibilityId?: string;
  state: "in_progress" | "completed" | "failed";
  resultText?: string;
  normalizedResultText?: string;
  error?: string;
};

export type SyntheticResponsibilityLedgerSnapshot = {
  revision: number;
  records: Record<string, ResponsibilityRecord>;
};

export type SyntheticExternalEventSnapshot = {
  id: string;
  processId: string;
  state: "pending" | "applied";
  appliedAtMs?: number;
};

export type SyntheticWorldSnapshot = {
  runtime: {
    now: string;
    timezone: string;
  };
  targets: Record<string, SyntheticTargetSnapshot>;
  processes: Record<string, SyntheticProcessSnapshot>;
  adapters: Record<string, SyntheticAdapterSnapshot>;
  responsibilities: SyntheticResponsibilityLedgerSnapshot;
  delegations: SyntheticDelegationSnapshot[];
  externalEvents: SyntheticExternalEventSnapshot[];
  transitionsApplied: string[];
};

export type SyntheticRunSnapshot = {
  run: number;
  processId: string;
  status: "yielded" | "returned" | "max_turns" | "invalid_action";
};

export type GsvSurfaceArtifact = {
  schemaVersion: 2;
  scenarioId: string;
  entryProcessId: string;
  status: "yielded" | "returned" | "max_turns" | "invalid_action";
  committedMessages: string[];
  resultText?: string;
  runs: SyntheticRunSnapshot[];
  observations: GsvSurfaceObservation[];
  log: GsvSemanticLogEntry[];
  world: SyntheticWorldSnapshot;
  error?: string;
};
