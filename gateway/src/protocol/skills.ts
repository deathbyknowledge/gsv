import type { CapabilityId } from "./tools";

export type SkillRequirementSnapshot = {
  capabilities: CapabilityId[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  location: string;
  always: boolean;
  eligible: boolean;
  eligibleHosts: string[];
  reasons: string[];
  requirements?: SkillRequirementSnapshot;
};

export type SkillNodeStatus = {
  nodeId: string;
  online: boolean;
  hostCapabilities: CapabilityId[];
};

export type SkillsStatusResult = {
  agentId: string;
  refreshedAt: number;
  nodes: SkillNodeStatus[];
  skills: SkillStatusEntry[];
};

export type SkillsUpdateResult = SkillsStatusResult;
