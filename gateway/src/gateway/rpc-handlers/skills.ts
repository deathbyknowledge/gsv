import { env } from "cloudflare:workers";
import {
  evaluateSkillEligibility,
  resolveEffectiveSkillPolicy,
} from "../../agents/prompt";
import { listWorkspaceSkills } from "../../skills";
import { normalizeAgentId } from "../../session/routing";
import type { Handler } from "../../protocol/methods";
import type { Gateway } from "../do";

function resolveAgentId(input: unknown): string {
  if (typeof input !== "string") {
    return "main";
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : "main";
}

async function collectSkillsStatus(gw: Gateway, agentId: string) {
  const normalizedAgentId = normalizeAgentId(agentId || "main");
  const config = gw.getFullConfig();
  const workspaceSkills = await listWorkspaceSkills(env.STORAGE, normalizedAgentId);
  const runtimeInventory = gw.nodeService.getRuntimeNodeInventory(gw.nodes.keys());

  const skillEntries = workspaceSkills
    .map((skill) => {
      const policy = resolveEffectiveSkillPolicy(skill, config.skills.entries);
      if (!policy) {
        return {
          name: skill.name,
          description: skill.description,
          location: skill.location,
          always: false,
          eligible: false,
          eligibleHosts: [],
          reasons: ["disabled by skills.entries policy"],
        };
      }

      const evaluation = evaluateSkillEligibility(policy, runtimeInventory);
      return {
        name: skill.name,
        description: skill.description,
        location: skill.location,
        always: policy.always,
        eligible: evaluation.eligible,
        eligibleHosts: evaluation.matchingHostIds,
        reasons: evaluation.reasons,
        requirements: policy.requires,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const nodeEntries = runtimeInventory.hosts
    .map((host) => ({
      nodeId: host.nodeId,
      online: host.online !== false,
      hostCapabilities: host.hostCapabilities,
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  return {
    agentId: normalizedAgentId,
    refreshedAt: Date.now(),
    nodes: nodeEntries,
    skills: skillEntries,
  };
}

export const handleSkillsStatus: Handler<"skills.status"> = async ({
  gw,
  params,
}) => {
  const agentId = resolveAgentId(params?.agentId);
  return await collectSkillsStatus(gw, agentId);
};

export const handleSkillsUpdate: Handler<"skills.update"> = async ({
  gw,
  params,
}) => {
  const agentId = resolveAgentId(params?.agentId);
  return await collectSkillsStatus(gw, agentId);
};
