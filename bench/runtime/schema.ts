import type {
  JsonObject,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import type { Message, Tool } from "@earendil-works/pi-ai";
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
  gids: number[];
  capabilities: string[];
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

export type SyntheticWorldSpec = {
  runtime: {
    now: string;
    timezone: string;
  };
  processes: SyntheticProcessSpec[];
  targets: SyntheticTargetSpec[];
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
  world: SyntheticWorldSpec;
  transitions: SyntheticTransitionSpec[];
  expected: JsonObject;
  expectedLog?: GsvSemanticLogEntry[];
  maxTurns: number;
};

export type GsvSurfaceObservation = {
  turn: number;
  processId: string;
  systemPromptSha256: string;
  projection: ContextProjection;
  messages: Message[];
  tools: Tool[];
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
  gids: number[];
  capabilities: string[];
  visibleTargets: string[];
};

export type SyntheticWorldSnapshot = {
  targets: Record<string, SyntheticTargetSnapshot>;
  processes: Record<string, SyntheticProcessSnapshot>;
  transitionsApplied: string[];
};

export type GsvSurfaceArtifact = {
  schemaVersion: 2;
  scenarioId: string;
  entryProcessId: string;
  status: "yielded" | "returned" | "max_turns" | "invalid_action";
  committedMessages: string[];
  resultText?: string;
  observations: GsvSurfaceObservation[];
  log: GsvSemanticLogEntry[];
  world: SyntheticWorldSnapshot;
  error?: string;
};
