import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import type { Gateway } from "../do";
import {
  buildChannelPrincipalId,
  normalizeChannelSenderId,
  normalizeId,
} from "../identity";

function findChannelForMessage(gw: Gateway, channel: string): string | null {
  const normalizedChannel = normalizeId(channel);
  for (const [channelKey, ws] of gw.channels.entries()) {
    if (
      channelKey.startsWith(`${normalizedChannel}:`) &&
      ws.readyState === WebSocket.OPEN
    ) {
      return channelKey;
    }
  }
  return null;
}

function resolvePrincipalBindingPolicy(
  gw: Gateway,
  channel: string,
): "manual" | "invite" | "auto-guest" | "auto-bind-default" {
  const channelPolicy = gw.getConfigPath(
    `channels.${normalizeId(channel)}.principalBindingPolicy`,
  );
  if (
    channelPolicy === "manual" ||
    channelPolicy === "invite" ||
    channelPolicy === "auto-guest" ||
    channelPolicy === "auto-bind-default"
  ) {
    return channelPolicy;
  }

  const hasSpacesConfig = gw.getConfigPath("spaces") !== undefined;
  if (!hasSpacesConfig) {
    return "auto-bind-default";
  }
  return "manual";
}

export const handlePairList: Handler<"pair.list"> = ({ gw }) => ({
  pairs: { ...gw.pendingPairs },
});

export const handlePairApprove: Handler<"pair.approve"> = ({ gw, params }) => {
  if (!params?.channel || !params?.senderId) {
    throw new RpcError(400, "channel and senderId required");
  }

  const normalizedChannel = normalizeId(params.channel);
  const normalizedId = normalizeChannelSenderId(params.senderId);
  const pairKey = `${normalizedChannel}:${normalizedId}`;

  const pending = gw.pendingPairs[pairKey];
  if (!pending) {
    throw new RpcError(404, `No pending pairing for ${pairKey}`);
  }

  // Add to allowFrom
  const config = gw.getFullConfig();
  const channelConfig = config.channels[normalizedChannel];
  const currentAllowFrom = channelConfig?.allowFrom ?? [];

  if (!currentAllowFrom.includes(normalizedId)) {
    const newAllowFrom = [...currentAllowFrom, normalizedId];
    gw.setConfigPath(`channels.${normalizedChannel}.allowFrom`, newAllowFrom);
  }

  const bindingPolicy = resolvePrincipalBindingPolicy(gw, normalizedChannel);
  const requiresBinding =
    bindingPolicy === "manual" || bindingPolicy === "invite";

  if (requiresBinding) {
    const accountId = pending.accountId || "default";
    gw.pendingPairs[pairKey] = {
      ...pending,
      channel: normalizedChannel,
      accountId,
      senderId: normalizedId,
      principalId:
        pending.principalId ||
        buildChannelPrincipalId(normalizedChannel, accountId, normalizedId),
      stage: "binding",
      requestedAt: pending.requestedAt || Date.now(),
    };
  } else {
    delete gw.pendingPairs[pairKey];
  }

  console.log(`[Gateway] Approved pairing for ${normalizedId}`);

  // Send confirmation message back to the channel
  // Find a connected channel to send through
  const channelKey = findChannelForMessage(gw, params.channel);
  if (channelKey) {
    const [, accountId] = channelKey.split(":");
    gw.sendChannelResponse(
      normalizedChannel,
      accountId,
      { kind: "dm", id: normalizedId }, // peer
      "", // no replyToId
      requiresBinding
        ? bindingPolicy === "invite"
          ? "You're now paired. Send `/claim <invite_code>` to complete registration."
          : "You're now paired. Final profile binding is still required before I can respond."
        : "You're now connected! Feel free to send me a message.",
    );
  }

  return {
    approved: true,
    senderId: normalizedId,
    senderName: pending.senderName,
    requiresBinding,
  };
};

export const handlePairReject: Handler<"pair.reject"> = ({ gw, params }) => {
  if (!params?.channel || !params?.senderId) {
    throw new RpcError(400, "channel and senderId required");
  }

  const normalizedChannel = normalizeId(params.channel);
  const normalizedId = normalizeChannelSenderId(params.senderId);
  const pairKey = `${normalizedChannel}:${normalizedId}`;

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
