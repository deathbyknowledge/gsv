import type { ModelProfile } from "../settings/types";

export type AgentRelation = "self" | "personal-agent" | "agent" | "human";

export type AccountSummary = {
  uid: number;
  username: string;
  displayName: string;
  relation: AgentRelation;
  runnable: boolean;
  gecos?: string;
};

export type AgentDetail = {
  uid: number;
  username: string;
  displayName: string;
  gecos?: string;
  relation: AgentRelation;
  runnable: boolean;
  configEditable: boolean;
  contextEditable: boolean;
  /** Per-agent model override (config key users/<uid>/ai/model); empty = inherit default. */
  model: string;
  /** Sparse per-agent model preset overrides keyed by config/ai/* field names. */
  aiValues: Record<string, string>;
  /** Effective model preset values after applying visible account overrides over system defaults. */
  effectiveAiValues: Record<string, string>;
  /** Per-agent tool approval policy as a JSON string; empty = inherit default. */
  approval: string;
};

export type AgentModelProfile = ModelProfile;

export type AgentsState = {
  agents: AgentDetail[];
  humans: AccountSummary[];
  modelProfiles: AgentModelProfile[];
  /** System-level AI defaults used when an agent account has no explicit override. */
  systemAiValues: Record<string, string>;
  /** Viewer-effective AI defaults used to create and display that viewer's model presets. */
  viewerAiValues: Record<string, string>;
  viewerUid: number;
  isRoot: boolean;
  errorText: string;
};

export type AgentContextFile = {
  name: string;
  text: string;
};

export type LoadAgentContextArgs = {
  username: string;
};

export type AgentContextResult = {
  files: AgentContextFile[];
  errorText: string;
};

export type SaveAgentContextArgs = {
  username: string;
  name: string;
  text: string;
};

export type SetAgentBehaviorArgs = {
  uid: number;
  aiValues?: Record<string, string>;
  model?: string;
  approval?: string;
};

export type CreateAgentArgs = {
  username: string;
  gecos?: string;
  persona?: string;
  contextFiles?: AgentContextFile[];
};

export type CreateHumanArgs = {
  username: string;
  password: string;
  gecos?: string;
};

export type AgentMutationResult = {
  ok: boolean;
  errorText: string;
};

export type ApprovalAction = "auto" | "ask" | "deny";

export type ApprovalRule = {
  match: string;
  action: ApprovalAction;
};

export type ApprovalPolicy = {
  default: ApprovalAction;
  rules: ApprovalRule[];
};
