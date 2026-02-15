import type { Handler } from "../../protocol/methods";

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

export const handleSkillsStatus: Handler<"skills.status"> = async ({
  gw,
  params,
}) => {
  const agentId = resolveAgentId(params?.agentId);
  return await gw.getSkillsStatus(agentId);
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
  const status = await gw.getSkillsStatus(agentId);

  return {
    ...status,
    updatedNodeCount: refreshed.updatedNodeCount,
    skippedNodeIds: refreshed.skippedNodeIds,
    errors: refreshed.errors,
  };
};

