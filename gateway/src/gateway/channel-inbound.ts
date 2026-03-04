import { env } from "cloudflare:workers";
import {
  isAllowedSender,
  normalizeE164,
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
  sendChannelResponse,
  sendTypingToChannel,
} from "./channel-transport";
import type { Gateway } from "./do";
import { claimInviteForPrincipal } from "./invites";

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSenderForPending(senderId: string): string {
  const normalized = normalizeE164(senderId);
  if (normalized) {
    return normalized;
  }
  return normalizeId(senderId);
}

function buildPrincipalId(
  channel: string,
  accountId: string,
  senderId: string,
): string {
  return `channel:${normalizeId(channel)}:${normalizeId(accountId)}:${normalizeId(senderId)}`;
}

function parseInviteClaimCode(messageText: string | undefined): string | undefined {
  const trimmed = (messageText ?? "").trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^(?:\/)?(?:claim|invite|register)\s+([a-zA-Z0-9-]{4,64})$/i.exec(
    trimmed,
  );
  const code = match?.[1]?.trim();
  return code || undefined;
}

export type ChannelInboundRpcResult = {
  ok: boolean;
  sessionKey?: string;
  threadId?: string;
  stateId?: string;
  status?: string;
  error?: string;
  [key: string]: unknown;
};

export async function handleChannelInboundRpc(
  gw: Gateway,
  params: ChannelInboundParams,
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
      const normalizedSenderId = normalizeSenderForPending(senderId);
      const pairKey = `${normalizeId(params.channel)}:${normalizedSenderId}`;
      if (!gw.pendingPairs[pairKey]) {
        gw.pendingPairs[pairKey] = {
          channel: normalizeId(params.channel),
          accountId: normalizeId(params.accountId),
          senderId: normalizedSenderId,
          principalId: buildPrincipalId(
            params.channel,
            params.accountId,
            normalizedSenderId,
          ),
          senderName: senderName,
          stage: "pairing",
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
        senderId: normalizedSenderId,
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

  const route = await gw.resolveInboundThreadRoute(params);
  if (route.status !== "ok") {
    if (route.state === "allowed_unbound") {
      const claimCode = parseInviteClaimCode(params.message.text);
      if (claimCode && route.principalId) {
        const claim = claimInviteForPrincipal(gw, {
          code: claimCode,
          principalId: route.principalId,
          channel: params.channel,
          senderId,
        });
        if (claim.ok) {
          sendChannelResponse(
            gw,
            params.channel,
            params.accountId,
            params.peer,
            params.message.id,
            "Invite claimed successfully. You are now registered. Send your message again to continue.",
          );
          return {
            ok: true,
            status: "invite_claimed",
            principalId: claim.principalId,
            homeSpaceId: claim.homeSpaceId,
            role: claim.role,
          };
        }

        sendChannelResponse(
          gw,
          params.channel,
          params.accountId,
          params.peer,
          params.message.id,
          claim.message,
        );
        return {
          ok: true,
          status: "invite_claim_failed",
          reason: claim.reason,
          principalId: route.principalId,
          surfaceId: route.surfaceId,
        };
      }

      const reason = route.reason === "conversation-not-bound"
        ? "This conversation is not yet bound to a space. Please ask an admin to configure it."
        : route.reason === "not-a-member-of-space"
          ? "Your account is not yet a member of the target space. Please ask an admin to grant access."
          : "Your account is approved but not yet assigned to a profile/space. Send `/claim <invite_code>` or ask an admin to complete setup.";
      sendChannelResponse(
        gw,
        params.channel,
        params.accountId,
        params.peer,
        params.message.id,
        reason,
      );
    }

    return {
      ok: true,
      status: route.state,
      reason: route.reason,
      principalId: route.principalId,
      surfaceId: route.surfaceId,
    };
  }

  const agentId = route.agentId;
  const threadId = route.threadId;
  const stateId = route.stateId;
  const sessionDoName = route.stateDoName;
  const sessionKey = route.legacySessionKey || sessionDoName;

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
    sessionKey: sessionDoName,
    timestamp: Date.now(),
  };

  const messageText = params.message.text;

  const command = parseCommand(messageText);
  if (command) {
    const commandResult = await executeChannelSlashCommand(
      gw,
      command,
      sessionDoName,
    );

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
        threadId,
        stateId,
        status: "command",
        command: command.name,
        response: commandResult.response,
      };
    }
  }

  const fullConfig = gw.getFullConfig();
  const sessionStub = env.SESSION.getByName(sessionDoName);

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
        `[Gateway] Failed to resolve session model provider for ${sessionDoName}, using global default:`,
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
      threadId,
      stateId,
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
    threadId,
    stateId,
    spaceId: route.spaceId,
    principalId: route.principalId,
    agentId,
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
    if (directives.thinkLevel)
      messageOverrides.thinkLevel = directives.thinkLevel;
    if (directives.model) messageOverrides.model = directives.model;

    let processedMedia = await processMediaWithTranscription(
      params.message.media,
      {
        workersAi: env.AI,
        openaiApiKey: fullConfig.apiKeys.openai,
        preferredProvider: fullConfig.transcription.provider,
      },
    );

    if (processedMedia.length > 0) {
      processedMedia = await processInboundMedia(
        processedMedia,
        env.STORAGE,
        {
          threadId,
          sessionKey,
        },
      );
    }

    const channelContext = {
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
      JSON.parse(JSON.stringify(gw.nodeService.listTools(gw.nodes.keys()))),
      JSON.parse(
        JSON.stringify(gw.nodeService.getRuntimeNodeInventory(gw.nodes.keys())),
      ),
      sessionDoName,
      messageOverrides,
      processedMedia.length > 0 ? processedMedia : undefined,
      channelContext,
    );

    if (result.paused) {
      sendTypingToChannel(
        gw,
        params.channel,
        params.accountId,
        params.peer,
        sessionKey,
        false,
      );
      sendChannelResponse(
        gw,
        params.channel,
        params.accountId,
        params.peer,
        params.message.id,
        result.response ??
          "Run is paused waiting for tool approval. Reply yes/no.",
      );
      return {
        ok: true,
        sessionKey,
        threadId,
        stateId,
        status: "paused",
        runId: result.runId,
        approvalId: result.approvalId,
      };
    }

    return {
      ok: true,
      sessionKey,
      threadId,
      stateId,
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
    return {
      ok: false,
      sessionKey,
      threadId,
      stateId,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
