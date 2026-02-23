import { env } from "cloudflare:workers";
import type {
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelWorkerInterface,
} from "../channel-interface";
import { resolveLinkedIdentity } from "../config/parsing";
import type {
  ChannelId,
  ChannelOutboundPayload,
  ChannelTypingPayload,
  PeerInfo,
} from "../protocol/channel";
import type { EventFrame } from "../protocol/frames";
import { buildAgentSessionKey } from "../session/routing";
import { trimLeadingBlankLines } from "../shared/utils";
import type { Gateway } from "./do";

export function getChannelBinding(
  channel: ChannelId,
): (Fetcher & ChannelWorkerInterface) | undefined {
  switch (channel) {
    case "whatsapp":
      return (env as any).CHANNEL_WHATSAPP as Fetcher & ChannelWorkerInterface;
    case "discord":
      return (env as any).CHANNEL_DISCORD as Fetcher & ChannelWorkerInterface;
    case "test":
      return (env as any).CHANNEL_TEST as Fetcher & ChannelWorkerInterface;
    default:
      return undefined;
  }
}

export function sendChannelResponse(
  gw: Gateway,
  channel: ChannelId,
  accountId: string,
  peer: PeerInfo,
  replyToId: string,
  text: string,
): void {
  const cleanedText = trimLeadingBlankLines(text);
  if (!cleanedText.trim()) {
    console.log(
      `[Gateway] Skipping empty channel response for ${channel}:${accountId}`,
    );
    return;
  }

  const channelBinding = getChannelBinding(channel);
  if (channelBinding) {
    const message: ChannelOutboundMessage = {
      peer: peer as ChannelPeer,
      text: cleanedText,
      replyToId,
    };
    channelBinding
      .send(accountId, message)
      .then((result) => {
        if (!result.ok) {
          console.error(`[Gateway] Channel RPC send failed: ${result.error}`);
        }
      })
      .catch((e) => {
        console.error(`[Gateway] Channel RPC error:`, e);
      });
    return;
  }

  const channelKey = `${channel}:${accountId}`;
  const channelWs = gw.channels.get(channelKey);

  if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
    console.log(
      `[Gateway] Channel ${channelKey} not connected for command response`,
    );
    return;
  }

  const outbound: ChannelOutboundPayload = {
    channel,
    accountId,
    peer,
    sessionKey: "",
    message: {
      text: cleanedText,
      replyToId,
    },
  };

  const evt: EventFrame<ChannelOutboundPayload> = {
    type: "evt",
    event: "channel.outbound",
    payload: outbound,
  };

  channelWs.send(JSON.stringify(evt));
}

export function sendTypingToChannel(
  gw: Gateway,
  channel: ChannelId,
  accountId: string,
  peer: PeerInfo,
  sessionKey: string,
  typing: boolean,
): void {
  const channelBinding = getChannelBinding(channel);
  if (channelBinding?.setTyping) {
    channelBinding
      .setTyping(accountId, peer as ChannelPeer, typing)
      .then(() => {
        console.log(
          `[Gateway] Sent typing=${typing} via RPC to ${channel}:${accountId}`,
        );
      })
      .catch((e) => {
        console.error(`[Gateway] Channel typing RPC error:`, e);
      });
    return;
  }

  const channelKey = `${channel}:${accountId}`;
  const channelWs = gw.channels.get(channelKey);

  if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
    return;
  }

  const payload: ChannelTypingPayload = {
    channel,
    accountId,
    peer,
    sessionKey,
    typing,
  };

  const evt: EventFrame<ChannelTypingPayload> = {
    type: "evt",
    event: "channel.typing",
    payload,
  };

  channelWs.send(JSON.stringify(evt));
  console.log(`[Gateway] Sent typing=${typing} to ${channelKey} for ${peer.id}`);
}

export function buildSessionKeyFromChannel(
  gw: Gateway,
  agentId: string,
  channel: ChannelId,
  accountId: string,
  peer: PeerInfo,
  senderId?: string,
): string {
  const config = gw.getFullConfig();
  const idToCheck = senderId || peer.id;
  const linkedIdentity = resolveLinkedIdentity(config, channel, idToCheck);

  if (linkedIdentity) {
    console.log(`[Gateway] Identity link: ${idToCheck} -> ${linkedIdentity}`);
  }

  return buildAgentSessionKey({
    agentId,
    channel,
    accountId,
    peer,
    dmScope: config.session.dmScope,
    mainKey: config.session.mainKey,
    linkedIdentity,
  });
}

export async function handleChannelStatusChanged(
  gw: Gateway,
  channelId: string,
  accountId: string,
  status: { connected: boolean; authenticated: boolean; error?: string },
): Promise<void> {
  const channelKey = `${channelId}:${accountId}`;
  console.log(
    `[Gateway] Channel status changed: ${channelKey} connected=${status.connected}`,
  );

  const existing = gw.channelRegistry[channelKey];
  if (existing) {
    gw.channelRegistry[channelKey] = {
      ...existing,
      connectedAt: status.connected ? Date.now() : existing.connectedAt,
    };
  } else if (status.connected) {
    gw.channelRegistry[channelKey] = {
      channel: channelId as ChannelId,
      accountId,
      connectedAt: Date.now(),
    };
  }
}
