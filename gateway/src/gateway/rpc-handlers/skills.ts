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

function resolveTimeoutMs(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return undefined;
  }
  return Math.floor(input);
}

function canNodeProbeBins(gw: Gateway, nodeId: string): boolean {
  const runtime = gw.nodeRuntimeRegistry[nodeId];
  if (!runtime) {
    return false;
  }
  return runtime.hostCapabilities.includes("shell.exec");
}

async function collectSkillsStatus(gw: Gateway, agentId: string) {
  const normalizedAgentId = normalizeAgentId(agentId || "main");
  const config = gw.getFullConfig();
  const workspaceSkills = await listWorkspaceSkills(env.STORAGE, normalizedAgentId);
  const runtimeInventory = gw.getRuntimeNodeInventory();

  const requiredBinsSet = new Set<string>();
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

      if (policy.requires) {
        for (const bin of [...policy.requires.bins, ...policy.requires.anyBins]) {
          requiredBinsSet.add(bin);
        }
      }

      const evaluation = evaluateSkillEligibility(policy, runtimeInventory, config);
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
      hostRole: host.hostRole,
      hostCapabilities: host.hostCapabilities,
      hostOs: host.hostOs,
      hostEnv: host.hostEnv ?? [],
      hostBins: host.hostBins ?? [],
      hostBinStatusUpdatedAt: host.hostBinStatusUpdatedAt,
      canProbeBins: canNodeProbeBins(gw, host.nodeId),
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  return {
    agentId: normalizedAgentId,
    refreshedAt: Date.now(),
    requiredBins: Array.from(requiredBinsSet).sort(),
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
  const refreshed = await gw.refreshSkillRuntimeFacts(agentId, {
    force: params?.force === true,
    timeoutMs: resolveTimeoutMs(params?.timeoutMs),
  });
  const status = await collectSkillsStatus(gw, agentId);

  return {
    ...status,
    updatedNodeCount: refreshed.updatedNodeCount,
    skippedNodeIds: refreshed.skippedNodeIds,
    errors: refreshed.errors,
  };
};
