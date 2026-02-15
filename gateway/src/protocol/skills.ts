import type { CapabilityId, HostRole } from "./tools";

export type SkillRequirementSnapshot = {
  hostRoles: HostRole[];
  capabilities: CapabilityId[];
  anyCapabilities: CapabilityId[];
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
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
  hostRole: HostRole;
  hostCapabilities: CapabilityId[];
  hostOs?: string;
  hostEnv: string[];
  hostBins: string[];
  hostBinStatusUpdatedAt?: number;
  canProbeBins: boolean;
};

export type SkillsStatusResult = {
  agentId: string;
  refreshedAt: number;
  requiredBins: string[];
  nodes: SkillNodeStatus[];
  skills: SkillStatusEntry[];
};

export type SkillsUpdateResult = SkillsStatusResult & {
  updatedNodeCount: number;
  skippedNodeIds: string[];
  errors: string[];
};

