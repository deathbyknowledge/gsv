import { env } from "cloudflare:workers";
import { parseCommand } from "../commands";
import {
  formatDirectiveAck,
  isDirectiveOnly,
  parseDirectives,
} from "../directives";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleChatSend: Handler<"chat.send"> = async ({ gw, params }) => {
  if (!params?.sessionKey || !params?.message) {
    throw new RpcError(400, "sessionKey and message required");
  }

  const messageText = params.message;

  // Check for slash commands first
  const command = parseCommand(messageText);
  if (command) {
    const commandResult = await gw.handleSlashCommandForChat(
      command,
      params.sessionKey,
    );

    if (commandResult.handled) {
      return {
        status: "command",
        command: command.name,
        response: commandResult.response,
        error: commandResult.error,
      };
    }
  }

  // Parse inline directives
  const directives = parseDirectives(messageText);

  // If message is only directives, acknowledge and return
  if (isDirectiveOnly(messageText)) {
    const ack = formatDirectiveAck(directives);
    return {
      status: "directive-only",
      response: ack,
      directives: {
        thinkLevel: directives.thinkLevel,
        model: directives.model,
      },
    };
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  const now = Date.now();
  const existing = gw.sessionRegistry[params.sessionKey];
  gw.sessionRegistry[params.sessionKey] = {
    sessionKey: params.sessionKey,
    createdAt: existing?.createdAt ?? now,
    lastActiveAt: now,
    label: existing?.label,
  };

  // Apply directive overrides for this message
  const messageOverrides: {
    thinkLevel?: string;
    model?: { provider: string; id: string };
  } = {};

  if (directives.thinkLevel) {
    messageOverrides.thinkLevel = directives.thinkLevel;
  }
  if (directives.model) {
    messageOverrides.model = directives.model;
  }

  const result = await sessionStub.chatSend(
    directives.cleaned, // Send cleaned message without directives
    params.runId ?? crypto.randomUUID(),
    JSON.parse(JSON.stringify(gw.getAllTools())),
    JSON.parse(JSON.stringify(gw.getRuntimeNodeInventory())),
    params.sessionKey,
    messageOverrides,
  );

  return {
    status: "started",
    runId: result.runId,
    directives:
      directives.hasThinkDirective || directives.hasModelDirective
        ? {
            thinkLevel: directives.thinkLevel,
            model: directives.model,
          }
        : undefined,
  };
};
