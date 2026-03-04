export type SessionRegistryEntry = {
  sessionKey: string;
  threadId?: string;
  stateId?: string;
  spaceId?: string;
  principalId?: string;
  agentId?: string;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
};
