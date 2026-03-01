import { env } from "cloudflare:workers";
import {
  HELP_TEXT,
  MODEL_SELECTOR_HELP,
  normalizeThinkLevel,
  parseCommand,
  parseModelSelection,
} from "../commands";
import {
  formatDirectiveAck,
  isDirectiveOnly,
  parseDirectives,
} from "../directives";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import type { Gateway } from "../do";

type SlashCommandResult = {
  handled: boolean;
  response?: string;
  error?: string;
};

async function handleSlashCommandForChat(
  gw: Gateway,
  command: { name: string; args: string },
  sessionKey: string,
): Promise<SlashCommandResult> {
  const sessionStub = env.SESSION.getByName(sessionKey);

  try {
    switch (command.name) {
      case "reset": {
        const result = await sessionStub.reset();
        return {
          handled: true,
          response: `Session reset. Archived ${result.archivedMessages} messages.`,
        };
      }

      case "compact": {
        const keepCount = command.args ? parseInt(command.args, 10) : 20;
        if (isNaN(keepCount) || keepCount < 1) {
          return {
            handled: true,
            error: "Invalid count. Usage: /compact [N]",
          };
        }
        const result = await sessionStub.compact(keepCount);
        return {
          handled: true,
          response: `Compacted session. Kept ${result.keptMessages} messages, archived ${result.trimmedMessages}.`,
        };
      }

      case "stop": {
        const result = await sessionStub.abort();
        if (result.wasRunning) {
          return {
            handled: true,
            response: `Stopped run ${result.runId}${result.pendingToolsCancelled > 0 ? `, cancelled ${result.pendingToolsCancelled} pending tool(s)` : ""}.`,
          };
        }
        return {
          handled: true,
          response: "No run in progress.",
        };
      }

      case "status": {
        const info = await sessionStub.get();
        const stats = await sessionStub.stats();
        const config = gw.getFullConfig();

        const lines = [
          `Session: ${sessionKey}`,
          `Messages: ${info.messageCount}`,
          `Tokens: ${stats.tokens.input} in / ${stats.tokens.output} out`,
          `Model: ${config.model.provider}/${config.model.id}`,
          info.settings.thinkingLevel
            ? `Thinking: ${info.settings.thinkingLevel}`
            : null,
          info.resetPolicy ? `Reset: ${info.resetPolicy.mode}` : null,
        ].filter(Boolean);

        return { handled: true, response: lines.join("\n") };
      }

      case "model": {
        const info = await sessionStub.get();
        const config = gw.getFullConfig();
        const effectiveModel = info.settings.model || config.model;

        if (!command.args) {
          return {
            handled: true,
            response: `Current model: ${effectiveModel.provider}/${effectiveModel.id}\n${MODEL_SELECTOR_HELP}`,
          };
        }

        const resolved = parseModelSelection(
          command.args,
          effectiveModel.provider,
        );
        if (!resolved) {
          return {
            handled: true,
            error: `Invalid model selector: ${command.args}\n${MODEL_SELECTOR_HELP}`,
          };
        }

        await sessionStub.patch({ settings: { model: resolved } });
        return {
          handled: true,
          response: `Model set to ${resolved.provider}/${resolved.id}`,
        };
      }

      case "think": {
        if (!command.args) {
          const info = await sessionStub.get();
          return {
            handled: true,
            response: `Thinking level: ${info.settings.thinkingLevel || "off"}\nLevels: off, minimal, low, medium, high, xhigh`,
          };
        }

        const level = normalizeThinkLevel(command.args);
        if (!level) {
          return {
            handled: true,
            error: `Invalid level: ${command.args}\nLevels: off, minimal, low, medium, high, xhigh`,
          };
        }

        await sessionStub.patch({ settings: { thinkingLevel: level } });
        return {
          handled: true,
          response: `Thinking level set to ${level}`,
        };
      }

      case "help":
        return { handled: true, response: HELP_TEXT };

      default:
        return { handled: false };
    }
  } catch (error) {
    return { handled: true, error: `Command failed: ${error}` };
  }
}

export const handleChatSend: Handler<"chat.send"> = async ({ gw, params }) => {
  if (!params?.sessionKey || !params?.message) {
    throw new RpcError(400, "sessionKey and message required");
  }

  const canonicalSessionKey = gw.canonicalizeSessionKey(params.sessionKey);

  const messageText = params.message;

  // Check for slash commands first
  const command = parseCommand(messageText);
  if (command) {
    const commandResult = await handleSlashCommandForChat(
      gw,
      command,
      canonicalSessionKey,
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

  const fullConfig = gw.getFullConfig();
  const sessionStub = env.SESSION.getByName(canonicalSessionKey);

  // Parse inline directives. For provider-less model selectors (e.g. /m:o3),
  // resolve against the session's current provider, not the global default.
  let directives = parseDirectives(messageText);
  const needsProviderFallback =
    directives.hasModelDirective &&
    !directives.model &&
    !!directives.rawModelDirective &&
    !directives.rawModelDirective.includes("/");

  if (needsProviderFallback) {
    try {
      const info = await sessionStub.get();
      const fallbackProvider =
        info.settings.model?.provider || fullConfig.model.provider;
      directives = parseDirectives(messageText, fallbackProvider);
    } catch (e) {
      console.warn(
        `[Gateway] Failed to resolve session model provider for ${canonicalSessionKey}, using global default:`,
        e,
      );
      directives = parseDirectives(messageText, fullConfig.model.provider);
    }
  }

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

  const now = Date.now();
  const existing = gw.sessionRegistry[canonicalSessionKey];
  gw.sessionRegistry[canonicalSessionKey] = {
    sessionKey: canonicalSessionKey,
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
    JSON.parse(JSON.stringify(gw.nodeService.listTools(gw.nodes.keys()))),
    JSON.parse(
      JSON.stringify(gw.nodeService.getRuntimeNodeInventory(gw.nodes.keys())),
    ),
    canonicalSessionKey,
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
