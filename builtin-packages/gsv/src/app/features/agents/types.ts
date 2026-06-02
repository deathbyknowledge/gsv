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
  relation: AgentRelation;
  runnable: boolean;
  /** Per-agent model override (config key users/<uid>/ai/model); empty = inherit default. */
  model: string;
  /** Per-agent tool approval policy as a JSON string; empty = inherit default. */
  approval: string;
};

export type AgentsState = {
  agents: AgentDetail[];
  humans: AccountSummary[];
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
  model?: string;
  approval?: string;
};

export type CreateAgentArgs = {
  username: string;
  gecos?: string;
  persona?: string;
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
