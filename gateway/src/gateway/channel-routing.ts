import type { ChannelOutboundMessage } from "../channel-interface";
import type { ChatEventPayload } from "../protocol/chat";
import type {
  ChannelOutboundPayload,
  SessionOutputContext,
} from "../protocol/channel";
import type { EventFrame } from "../protocol/frames";
import { trimLeadingBlankLines } from "../shared/utils";
import { shouldDeliverResponse } from "./heartbeat";
import type { Gateway } from "./do";

export function routePayloadToChannel(
  gw: Gateway,
  sessionKey: string,
  context: SessionOutputContext,
  payload: ChatEventPayload,
): void {
  // Extract text from response
  let text = "";
  const msg = payload.message as { content?: unknown } | undefined;
  if (msg?.content) {
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && block && "type" in block) {
          if (
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            text += (block as { text: string }).text;
          }
        }
      }
    }
  }

  text = trimLeadingBlankLines(text);
  if (!text.trim()) {
    console.log(`[Gateway] No text content in response for ${sessionKey}`);
    return;
  }

  const isHeartbeat = context.inboundMessageId.startsWith("heartbeat:");

  if (isHeartbeat) {
    const { deliver, cleanedText } = shouldDeliverResponse(text);

    if (!deliver) {
      console.log(`[Gateway] Heartbeat response suppressed (HEARTBEAT_OK or short ack)`);
      return;
    }

    text = cleanedText || text;

    // Deduplication: Skip if same text was sent within 24 hours.
    const agentId = context.agentId;
    if (agentId) {
      const state = gw.heartbeatState[agentId];
      const now = Date.now();
      const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

      if (
        state?.lastHeartbeatText &&
        state?.lastHeartbeatSentAt &&
        state.lastHeartbeatText.trim() === text.trim() &&
        now - state.lastHeartbeatSentAt < DEDUP_WINDOW_MS
      ) {
        console.log(
          `[Gateway] Heartbeat response deduplicated for ${agentId} (same text within 24h)`,
        );
        return;
      }

      gw.heartbeatState[agentId] = {
        ...state,
        agentId,
        lastHeartbeatText: text.trim(),
        lastHeartbeatSentAt: now,
        nextHeartbeatAt: state?.nextHeartbeatAt ?? null,
        lastHeartbeatAt: state?.lastHeartbeatAt ?? null,
      };
    }
  }

  const replyToId = isHeartbeat ? undefined : context.inboundMessageId;
  const channelBinding = gw.getChannelBinding(context.channel);

  if (channelBinding) {
    const message: ChannelOutboundMessage = JSON.parse(
      JSON.stringify({
        peer: {
          kind: context.peer.kind,
          id: context.peer.id,
          name: context.peer.name,
        },
        text,
        replyToId,
      }),
    );
    channelBinding
      .send(context.accountId, message)
      .then((result) => {
        if (result.ok) {
          console.log(
            `[Gateway] Routed response via RPC to ${context.channel}:${context.accountId}${isHeartbeat ? " (heartbeat)" : ""}`,
          );
        } else {
          console.error(`[Gateway] Channel RPC send failed: ${result.error}`);
        }
      })
      .catch((error) => {
        console.error(`[Gateway] Channel RPC error:`, error);
      });
    return;
  }

  const channelKey = `${context.channel}:${context.accountId}`;
  const channelWs = gw.channels.get(channelKey);

  if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
    console.log(
      `[Gateway] Channel ${channelKey} not connected for outbound (no RPC binding, no WebSocket)`,
    );
    return;
  }

  const outbound: ChannelOutboundPayload = {
    channel: context.channel,
    accountId: context.accountId,
    peer: context.peer,
    sessionKey,
    message: {
      text,
      replyToId,
    },
  };

  const evt: EventFrame<ChannelOutboundPayload> = {
    type: "evt",
    event: "channel.outbound",
    payload: outbound,
  };

  channelWs.send(JSON.stringify(evt));
  console.log(
    `[Gateway] Routed response to channel ${channelKey}${isHeartbeat ? " (heartbeat)" : ""}`,
  );
}
