import { normalizeE164 } from "../../config/parsing";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import type { Gateway } from "../do";

function findChannelForMessage(gw: Gateway, channel: string): string | null {
  for (const [channelKey, ws] of gw.channels.entries()) {
    if (
      channelKey.startsWith(`${channel}:`) &&
      ws.readyState === WebSocket.OPEN
    ) {
      return channelKey;
    }
  }
  return null;
}

export const handlePairList: Handler<"pair.list"> = ({ gw }) => ({
  pairs: { ...gw.pendingPairs },
});

export const handlePairApprove: Handler<"pair.approve"> = ({ gw, params }) => {
  if (!params?.channel || !params?.senderId) {
    throw new RpcError(400, "channel and senderId required");
  }

  const normalizedId = normalizeE164(params.senderId);
  const pairKey = `${params.channel}:${normalizedId}`;

  const pending = gw.pendingPairs[pairKey];
  if (!pending) {
    throw new RpcError(404, `No pending pairing for ${pairKey}`);
  }

  // Add to allowFrom
  const config = gw.getFullConfig();
  const channelConfig = config.channels[params.channel];
  const currentAllowFrom = channelConfig?.allowFrom ?? [];

  if (!currentAllowFrom.includes(normalizedId)) {
    const newAllowFrom = [...currentAllowFrom, normalizedId];
    gw.setConfigPath(`channels.${params.channel}.allowFrom`, newAllowFrom);
  }

  // Remove from pending
  delete gw.pendingPairs[pairKey];

  console.log(`[Gateway] Approved pairing for ${normalizedId}`);

  // Send confirmation message back to the channel
  // Find a connected channel to send through
  const channelKey = findChannelForMessage(gw, params.channel);
  if (channelKey) {
    const [channel, accountId] = channelKey.split(":");
    gw.sendChannelResponse(
      params.channel,
      accountId,
      { kind: "dm", id: normalizedId }, // peer
      "", // no replyToId
      `You're now connected! Feel free to send me a message.`,
    );
  }

  return {
    approved: true,
    senderId: normalizedId,
    senderName: pending.senderName,
  };
};

export const handlePairReject: Handler<"pair.reject"> = ({ gw, params }) => {
  if (!params?.channel || !params?.senderId) {
    throw new RpcError(400, "channel and senderId required");
  }

  const normalizedId = normalizeE164(params.senderId);
  const pairKey = `${params.channel}:${normalizedId}`;

  if (!gw.pendingPairs[pairKey]) {
    throw new RpcError(404, `No pending pairing for ${pairKey}`);
  }

  delete gw.pendingPairs[pairKey];

  console.log(`[Gateway] Rejected pairing for ${normalizedId}`);

  return {
    rejected: true,
    senderId: normalizedId,
  };
};
