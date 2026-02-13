import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";

export const getMessageToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.MESSAGE,
    description:
      "Send a message to a channel/user. " +
      "When called without channel/to, sends to the user's current conversation " +
      "(last active channel and peer). " +
      "Specify channel and to explicitly only when sending to a different target.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Message text to send. Required.",
        },
        channel: {
          type: "string",
          description:
            'Channel to send to (e.g., "whatsapp", "discord"). ' +
            "Defaults to the user's current channel if omitted.",
        },
        to: {
          type: "string",
          description:
            "Peer ID to send to (phone number, user ID, channel ID, etc.). " +
            "Defaults to the user's current peer if omitted.",
        },
        peerKind: {
          type: "string",
          enum: ["dm", "group", "channel", "thread"],
          description:
            'Type of conversation. Defaults to the current peer kind, or "dm" if unknown.',
        },
        accountId: {
          type: "string",
          description:
            "Account ID for multi-account channels. Defaults to the current account.",
        },
        replyToId: {
          type: "string",
          description: "Optional message ID to reply to.",
        },
      },
      required: ["text"],
    },
  },
];

export const messageNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.MESSAGE]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "Message tool unavailable: gateway context missing",
      };
    }

    const payload = await context.gateway.executeMessageTool(
      context.agentId,
      args,
    );
    return {
      ok: true,
      result: payload,
    };
  },
};
