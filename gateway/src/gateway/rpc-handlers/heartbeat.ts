import type { Handler } from "../../protocol/methods";
import type { Gateway } from "../do";

function buildHeartbeatStatus(gw: Gateway): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [agentId, state] of Object.entries(gw.heartbeatState)) {
    const lastActive = gw.lastActiveContext[agentId];
    result[agentId] = {
      ...state,
      lastActive: lastActive
        ? {
            channel: lastActive.channel,
            accountId: lastActive.accountId,
            peer: lastActive.peer,
            timestamp: lastActive.timestamp,
          }
        : undefined,
    };
  }

  for (const [agentId, context] of Object.entries(gw.lastActiveContext)) {
    if (!result[agentId]) {
      result[agentId] = {
        agentId,
        nextHeartbeatAt: null,
        lastHeartbeatAt: null,
        lastHeartbeatText: null,
        lastHeartbeatSentAt: null,
        lastActive: {
          channel: context.channel,
          accountId: context.accountId,
          peer: context.peer,
          timestamp: context.timestamp,
        },
      };
    }
  }

  return result;
}

export const handleHeartbeatTrigger: Handler<"heartbeat.trigger"> = async (
  { gw, params },
) => {
  const agentId = params?.agentId ?? "main";
  return await gw.triggerHeartbeat(agentId);
};

export const handleHeartbeatStatus: Handler<"heartbeat.status"> = async ({
  gw,
}) => {
  const status = buildHeartbeatStatus(gw);
  return { agents: status };
};

export const handleHeartbeatStart: Handler<"heartbeat.start"> = async ({
  gw,
}) => {
  await gw.scheduleHeartbeat();
  const status = buildHeartbeatStatus(gw);
  return {
    message: "Heartbeat scheduler started",
    agents: status,
  };
};
