import {
  isAllowedSender,
  normalizeE164,
  resolveAgentIdFromBinding,
} from "../config/parsing";
import {
  formatDirectiveAck,
  isDirectiveOnly,
  parseDirectives,
} from "./directives";
import { formatEnvelope, resolveTimezone } from "../shared/time";
import type { ChannelInboundParams } from "../protocol/channel";
import { processMediaWithTranscription } from "../transcription";
import { processInboundMedia } from "../storage/media";
import { parseCommand } from "./commands";
import { executeChannelSlashCommand } from "./tool-executors";
import {
  buildSessionKeyFromChannel,
  sendChannelResponse,
  sendTypingToChannel,
} from "./channel-transport";
import type { Gateway } from "./do";

export type ChannelInboundRpcResult = {
  ok: boolean;
  sessionKey?: string;
  status?: string;
  error?: string;
  [key: string]: unknown;
};

export type ChannelInboundDeps = {
  getSessionStub: (sessionKey: string) => ReturnType<Env["SESSION"]["get"]>;
  workersAi: Env["AI"];
  storage: Env["STORAGE"];
};

export async function handleChannelInboundRpc(
  gw: Gateway,
  params: ChannelInboundParams,
  deps: ChannelInboundDeps,
): Promise<ChannelInboundRpcResult> {
  if (
    !params?.channel ||
    !params?.accountId ||
    !params?.peer ||
    !params?.message
  ) {
    return {
      ok: false,
      error: "channel, accountId, peer, and message required",
    };
  }

  const config = gw.getConfig();

  const senderId = params.sender?.id ?? params.peer.id;
  const senderName = params.sender?.name ?? params.peer.name;
  const allowCheck = isAllowedSender(
    config,
    params.channel,
    senderId,
    params.peer.id,
  );

  if (!allowCheck.allowed) {
    if (allowCheck.needsPairing) {
      const pairKey = `${params.channel}:${normalizeE164(senderId)}`;
      if (!gw.pendingPairs[pairKey]) {
        gw.pendingPairs[pairKey] = {
          channel: params.channel,
          senderId: normalizeE164(senderId),
          senderName: senderName,
          requestedAt: Date.now(),
          firstMessage: params.message.text?.slice(0, 200),
        };
        console.log(
          `[Gateway] New pairing request from ${senderId} (${senderName})`,
        );

        sendChannelResponse(
          gw,
          params.channel,
          params.accountId,
          params.peer,
          params.message.id,
          "Your message has been received. Awaiting approval from the owner.",
        );
      }
      return {
        ok: true,
        status: "pending_pairing",
        senderId: normalizeE164(senderId),
      };
    }

    console.log(
      `[Gateway] Blocked message from ${senderId}: ${allowCheck.reason}`,
    );
    return {
      ok: true,
      status: "blocked",
      reason: allowCheck.reason,
    };
  }

  const agentId = resolveAgentIdFromBinding(
    config,
    params.channel,
    params.accountId,
    params.peer,
  );
  const sessionKey = buildSessionKeyFromChannel(
    gw,
    agentId,
    params.channel,
    params.accountId,
    params.peer,
    senderId,
  );

  const channelKey = `${params.channel}:${params.accountId}`;
  const existing = gw.channelRegistry[channelKey];
  if (existing) {
    gw.channelRegistry[channelKey] = {
      ...existing,
      lastMessageAt: Date.now(),
    };
  }

  gw.lastActiveContext[agentId] = {
    agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    sessionKey,
    timestamp: Date.now(),
  };

  const messageText = params.message.text;

  const command = parseCommand(messageText);
  if (command) {
    const commandResult = await executeChannelSlashCommand(gw, command, sessionKey);

    if (commandResult.handled) {
      sendChannelResponse(
        gw,
        params.channel,
        params.accountId,
        params.peer,
        params.message.id,
        commandResult.response || commandResult.error || "Command executed",
      );
      return {
        ok: true,
        sessionKey,
        status: "command",
        command: command.name,
        response: commandResult.response,
      };
    }
  }

  const fullConfig = gw.getFullConfig();
  const sessionStub = deps.getSessionStub(sessionKey);

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
        `[Gateway] Failed to resolve session model provider for ${sessionKey}, using global default:`,
        e,
      );
      directives = parseDirectives(messageText, fullConfig.model.provider);
    }
  }

  if (isDirectiveOnly(messageText)) {
    const ack = formatDirectiveAck(directives);
    if (ack) {
      sendChannelResponse(
        gw,
        params.channel,
        params.accountId,
        params.peer,
        params.message.id,
        ack,
      );
    }
    return {
      ok: true,
      sessionKey,
      status: "directive-only",
      directives: {
        thinkLevel: directives.thinkLevel,
        model: directives.model,
      },
    };
  }

  const now = Date.now();
  const existingSession = gw.sessionRegistry[sessionKey];
  gw.sessionRegistry[sessionKey] = {
    sessionKey,
    createdAt: existingSession?.createdAt ?? now,
    lastActiveAt: now,
    label: existingSession?.label ?? params.peer.name,
  };

  const runId = crypto.randomUUID();

  try {
    const messageOverrides: {
      thinkLevel?: string;
      model?: { provider: string; id: string };
    } = {};
    if (directives.thinkLevel) messageOverrides.thinkLevel = directives.thinkLevel;
    if (directives.model) messageOverrides.model = directives.model;

    let processedMedia = await processMediaWithTranscription(
      params.message.media,
      {
        workersAi: deps.workersAi,
        openaiApiKey: fullConfig.apiKeys.openai,
        preferredProvider: fullConfig.transcription.provider,
      },
    );

    if (processedMedia.length > 0) {
      processedMedia = await processInboundMedia(
        processedMedia,
        deps.storage,
        sessionKey,
      );
    }

    gw.pendingChannelResponses[runId] = {
      channel: params.channel,
      accountId: params.accountId,
      peer: params.peer,
      inboundMessageId: params.message.id,
    };

    const tz = resolveTimezone(fullConfig.userTimezone);
    const senderLabel = params.sender?.name ?? params.peer.name;
    const envelopedMessage = formatEnvelope(directives.cleaned, {
      channel: params.channel,
      timestamp: new Date(),
      timezone: tz,
      peerKind: params.peer.kind,
      sender: senderLabel,
    });

    sendTypingToChannel(
      gw,
      params.channel,
      params.accountId,
      params.peer,
      sessionKey,
      true,
    );

    const result = await sessionStub.chatSend(
      envelopedMessage,
      runId,
      JSON.parse(JSON.stringify(gw.getAllTools())),
      JSON.parse(JSON.stringify(gw.getRuntimeNodeInventory())),
      sessionKey,
      messageOverrides,
      processedMedia.length > 0 ? processedMedia : undefined,
      {
        channel: params.channel,
        accountId: params.accountId,
        peer: {
          kind: params.peer.kind,
          id: params.peer.id,
          name: params.peer.name,
        },
      },
    );

    return {
      ok: true,
      sessionKey,
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
  } catch (e) {
    sendTypingToChannel(
      gw,
      params.channel,
      params.accountId,
      params.peer,
      sessionKey,
      false,
    );
    delete gw.pendingChannelResponses[runId];
    return {
      ok: false,
      sessionKey,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
