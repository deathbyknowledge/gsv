import { env } from "cloudflare:workers";
import type { ChannelOutboundMessage, ChannelPeer } from "../channel-interface";
import {
  normalizeCronToolJobCreateInput,
  normalizeCronToolJobPatchInput,
  type CronJob,
} from "../cron";
import type { ChannelOutboundPayload, PeerInfo } from "../protocol/channel";
import type { EventFrame } from "../protocol/frames";
import { formatTimeFull, resolveTimezone } from "../shared/time";
import {
  HELP_TEXT,
  MODEL_SELECTOR_HELP,
  normalizeThinkLevel,
  parseModelSelection,
} from "./commands";
import type { Gateway } from "./do";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asMode(value: unknown): "due" | "force" | undefined {
  if (value === "due" || value === "force") {
    return value;
  }
  return undefined;
}

function formatCronDuration(ms: number): string {
  if (ms % 86_400_000 === 0) {
    const days = ms / 86_400_000;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (ms % 1_000 === 0) {
    const seconds = ms / 1_000;
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  return `${ms} ms`;
}

function describeCronSchedule(job: CronJob, timezone: string): string {
  if (job.schedule.kind === "at") {
    return `one-shot at ${formatTimeFull(new Date(job.schedule.atMs), timezone)}`;
  }

  if (job.schedule.kind === "every") {
    const base = `every ${formatCronDuration(job.schedule.everyMs)}`;
    if (job.schedule.anchorMs !== undefined) {
      return `${base} (anchor ${formatTimeFull(new Date(job.schedule.anchorMs), timezone)})`;
    }
    return `${base} (starting from creation time)`;
  }

  const tz = job.schedule.tz || timezone;
  return `cron "${job.schedule.expr}" (${tz})`;
}

export async function executeCronTool(
  gw: Gateway,
  args: Record<string, unknown>,
): Promise<unknown> {
  const actionRaw = typeof args.action === "string" ? args.action : "status";
  const action = actionRaw.trim().toLowerCase();

  switch (action) {
    case "status": {
      const status = await gw.getCronStatus();
      const config = gw.getFullConfig();
      const tz = resolveTimezone(config.userTimezone);
      return {
        ...status,
        currentTime: formatTimeFull(new Date(), tz),
        timezone: tz,
      };
    }
    case "list": {
      const listed = await gw.listCronJobs({
        agentId: asString(args.agentId),
        includeDisabled:
          typeof args.includeDisabled === "boolean"
            ? args.includeDisabled
            : undefined,
        limit: asNumber(args.limit),
        offset: asNumber(args.offset),
      });
      const config = gw.getFullConfig();
      const timezone = resolveTimezone(config.userTimezone);
      return {
        ...listed,
        timezone,
        currentTime: formatTimeFull(new Date(), timezone),
        jobs: listed.jobs.map((job) => ({
          ...job,
          scheduleHuman: describeCronSchedule(job, timezone),
          nextRunHuman:
            job.state.nextRunAtMs !== undefined
              ? formatTimeFull(new Date(job.state.nextRunAtMs), timezone)
              : undefined,
          lastRunHuman:
            job.state.lastRunAtMs !== undefined
              ? formatTimeFull(new Date(job.state.lastRunAtMs), timezone)
              : undefined,
        })),
      };
    }
    case "add": {
      const jobInput = asObject(args.job) ?? args;
      if (!jobInput || typeof jobInput !== "object") {
        throw new Error("cron add requires a job object");
      }
      const ji = jobInput as Record<string, unknown>;
      if (!ji.name || !ji.schedule || !ji.spec) {
        throw new Error("cron add requires name, schedule, and spec");
      }
      const config = gw.getFullConfig();
      const timezone = resolveTimezone(config.userTimezone);
      const normalizedInput = normalizeCronToolJobCreateInput(ji, timezone);
      const job = await gw.addCronJob(normalizedInput);
      return { ok: true, job };
    }
    case "update": {
      const id = asString(args.id);
      if (!id) {
        throw new Error("cron update requires id");
      }
      const patch = asObject(args.patch);
      if (!patch) {
        throw new Error("cron update requires patch object");
      }
      const config = gw.getFullConfig();
      const timezone = resolveTimezone(config.userTimezone);
      const normalizedPatch = normalizeCronToolJobPatchInput(patch, timezone);
      const job = await gw.updateCronJob(id, normalizedPatch);
      return { ok: true, job };
    }
    case "remove": {
      const id = asString(args.id);
      if (!id) {
        throw new Error("cron remove requires id");
      }
      const result = await gw.removeCronJob(id);
      return { ok: true, removed: result.removed };
    }
    case "run":
      return {
        ok: true,
        ...(await gw.runCronJobs({
          id: asString(args.id),
          mode: asMode(args.mode),
        })),
      };
    case "runs":
      return await gw.listCronRuns({
        jobId: asString(args.jobId),
        limit: asNumber(args.limit),
        offset: asNumber(args.offset),
      });
    default:
      throw new Error(`Unknown cron action: ${action}`);
  }
}

export async function executeMessageTool(
  gw: Gateway,
  agentId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const text = asString(args.text);
  if (!text) {
    throw new Error("text is required");
  }

  // Resolve defaults from last active channel context
  const lastActive = gw.lastActiveContext[agentId];

  const channel = asString(args.channel) ?? lastActive?.channel;
  if (!channel) {
    throw new Error("channel is required (no current channel context available)");
  }
  const to = asString(args.to) ?? lastActive?.peer?.id;
  if (!to) {
    throw new Error("to (peer ID) is required (no current peer context available)");
  }

  const peerKind = asString(args.peerKind) ?? lastActive?.peer?.kind ?? "dm";
  if (!["dm", "group", "channel", "thread"].includes(peerKind)) {
    throw new Error(
      `Invalid peerKind: ${peerKind}. Must be dm, group, channel, or thread.`,
    );
  }
  const accountId = asString(args.accountId) ?? lastActive?.accountId ?? "default";
  const replyToId = asString(args.replyToId);

  const peer: ChannelPeer = {
    kind: peerKind as ChannelPeer["kind"],
    id: to,
  };
  const message: ChannelOutboundMessage = {
    peer,
    text,
    replyToId,
  };

  // Try Service Binding RPC first
  const channelBinding = gw.getChannelBinding(channel);
  if (channelBinding) {
    const result = await channelBinding.send(accountId, message);
    if (!result.ok) {
      throw new Error(`Channel send failed: ${result.error}`);
    }
    return {
      sent: true,
      channel,
      to,
      peerKind,
      accountId,
      messageId: result.messageId,
    };
  }

  // WebSocket fallback
  const channelKey = `${channel}:${accountId}`;
  const channelWs = gw.channels.get(channelKey);
  if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
    throw new Error(
      `Channel "${channel}" (account: ${accountId}) is not connected. ` +
        `Make sure the channel is started and connected.`,
    );
  }

  const outbound: ChannelOutboundPayload = {
    channel,
    accountId,
    peer: { kind: peerKind as PeerInfo["kind"], id: to },
    sessionKey: "",
    message: { text, replyToId },
  };
  const evt: EventFrame<ChannelOutboundPayload> = {
    type: "evt",
    event: "channel.outbound",
    payload: outbound,
  };
  channelWs.send(JSON.stringify(evt));

  return {
    sent: true,
    channel,
    to,
    peerKind,
    accountId,
    via: "websocket",
  };
}

export async function executeSessionsListTool(
  gw: Gateway,
  args: Record<string, unknown>,
): Promise<unknown> {
  const limit = Math.min(Math.max(asNumber(args.limit) ?? 20, 1), 100);
  const offset = Math.max(asNumber(args.offset) ?? 0, 0);
  const messageLimit = Math.min(Math.max(asNumber(args.messageLimit) ?? 0, 0), 20);

  const allSessions = Object.values(gw.sessionRegistry).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );

  const page = allSessions.slice(offset, offset + limit);

  const sessions: unknown[] = [];
  for (const entry of page) {
    const row: Record<string, unknown> = {
      sessionKey: entry.sessionKey,
      label: entry.label,
      lastActiveAt: entry.lastActiveAt,
      createdAt: entry.createdAt,
    };

    if (messageLimit > 0) {
      try {
        const sessionStub = env.SESSION.getByName(entry.sessionKey);
        const preview = await sessionStub.preview(messageLimit);
        row.messageCount = preview.messageCount;
        row.messages = preview.messages;
      } catch (error) {
        row.messageCount = 0;
        row.messages = [];
        row.previewError = String(error);
      }
    }

    sessions.push(row);
  }

  return {
    sessions,
    count: allSessions.length,
    offset,
    limit,
  };
}

export async function executeSessionSendTool(
  gw: Gateway,
  _callerAgentId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rawSessionKey = asString(args.sessionKey);
  if (!rawSessionKey) {
    throw new Error("sessionKey is required");
  }
  const message = asString(args.message);
  if (!message) {
    throw new Error("message is required");
  }
  const waitSeconds = Math.min(Math.max(asNumber(args.waitSeconds) ?? 30, 0), 120);

  const sessionKey = gw.canonicalizeSessionKey(rawSessionKey);
  const runId = crypto.randomUUID();
  const sessionStub = env.SESSION.getByName(sessionKey);

  const tools = JSON.parse(JSON.stringify(gw.nodeService.listTools(gw.nodes.keys())));
  const runtimeNodes = JSON.parse(
    JSON.stringify(gw.nodeService.getRuntimeNodeInventory(gw.nodes.keys())),
  );

  const result = await sessionStub.chatSend(
    message,
    runId,
    tools,
    runtimeNodes,
    sessionKey,
  );

  if (!result.ok) {
    throw new Error("Failed to inject message into session");
  }

  if (waitSeconds === 0) {
    return {
      status: "accepted",
      runId,
      sessionKey,
      queued: result.queued ?? false,
    };
  }

  const deadline = Date.now() + waitSeconds * 1000;
  const pollIntervalMs = 500;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const preview = await sessionStub.preview(5);
      const messages = preview.messages as Array<{ role?: string; content?: unknown }>;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.role !== "assistant" || !msg.content) {
          continue;
        }

        const content = msg.content;
        let reply: string | undefined;
        if (typeof content === "string") {
          reply = content;
        } else if (Array.isArray(content)) {
          reply = content
            .filter((block: { type?: string }) => block.type === "text")
            .map((block: { text?: string }) => block.text ?? "")
            .join("");
        }
        if (reply) {
          return {
            status: "ok",
            runId,
            sessionKey,
            reply,
          };
        }
      }
    } catch {
      // Session might not be ready yet, keep polling.
    }
  }

  return {
    status: "timeout",
    runId,
    sessionKey,
    waitedSeconds: waitSeconds,
  };
}

export async function executeChannelSlashCommand(
  gw: Gateway,
  command: { name: string; args: string },
  sessionKey: string,
): Promise<{ handled: boolean; response?: string; error?: string }> {
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
            response: `Stopped run \`${result.runId}\`${result.pendingToolsCancelled > 0 ? `, cancelled ${result.pendingToolsCancelled} pending tool(s)` : ""}.`,
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
          `**Session Status**`,
          `• Session: \`${sessionKey}\``,
          `• Messages: ${info.messageCount}`,
          `• Tokens: ${stats.tokens.input} in / ${stats.tokens.output} out`,
          `• Model: ${config.model.provider}/${config.model.id}`,
          info.settings.thinkingLevel ? `• Thinking: ${info.settings.thinkingLevel}` : null,
          info.resetPolicy ? `• Reset: ${info.resetPolicy.mode}` : null,
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
            response: `Current model: ${effectiveModel.provider}/${effectiveModel.id}\n\n${MODEL_SELECTOR_HELP}`,
          };
        }

        const resolved = parseModelSelection(command.args, effectiveModel.provider);
        if (!resolved) {
          return {
            handled: true,
            error: `Invalid model selector: ${command.args}\n\n${MODEL_SELECTOR_HELP}`,
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
            response: `Thinking level: ${info.settings.thinkingLevel || "off"}\n\nLevels: off, minimal, low, medium, high, xhigh`,
          };
        }

        const level = normalizeThinkLevel(command.args);
        if (!level) {
          return {
            handled: true,
            error: `Invalid level: ${command.args}\n\nLevels: off, minimal, low, medium, high, xhigh`,
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
    return {
      handled: true,
      error: `Command failed: ${error}`,
    };
  }
}
