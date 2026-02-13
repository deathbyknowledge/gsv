import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";

export const getSessionsToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.SESSIONS_LIST,
    description:
      "List active sessions with metadata. " +
      "Shows session keys, labels, last activity times, and optionally recent messages.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of sessions to return. Default 20, max 100.",
        },
        offset: {
          type: "number",
          description: "Pagination offset. Default 0.",
        },
        messageLimit: {
          type: "number",
          description:
            "Number of recent messages to include per session (0-20). Default 0 (none).",
        },
      },
      required: [],
    },
  },
  {
    name: NATIVE_TOOLS.SESSION_SEND,
    description:
      "Send a message into another session. " +
      "The message is injected as a user message and triggers an agent turn. " +
      "Can optionally wait for the agent's reply.",
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          description:
            "Target session key (e.g., 'main', 'agent:helper:main'). Required.",
        },
        message: {
          type: "string",
          description: "Message text to send. Required.",
        },
        waitSeconds: {
          type: "number",
          description:
            "Seconds to wait for a reply (0 = fire-and-forget). Default 30, max 120.",
        },
      },
      required: ["sessionKey", "message"],
    },
  },
];

export const sessionsNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.SESSIONS_LIST]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "SessionsList tool unavailable: gateway context missing",
      };
    }

    const payload = await context.gateway.executeSessionsListTool(args);
    return {
      ok: true,
      result: payload,
    };
  },

  [NATIVE_TOOLS.SESSION_SEND]: async (context, args) => {
    if (!context.gateway) {
      return {
        ok: false,
        error: "SessionSend tool unavailable: gateway context missing",
      };
    }

    const payload = await context.gateway.executeSessionSendTool(
      context.agentId,
      args,
    );
    return {
      ok: true,
      result: payload,
    };
  },
};
