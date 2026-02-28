/**
 * Heartbeat System
 *
 * Periodic check-ins that allow the agent to:
 * - Read HEARTBEAT.md and follow its instructions
 * - Send proactive messages to channels
 * - Process scheduled tasks
 */

import { env } from "cloudflare:workers";
import type { HeartbeatConfig, GsvConfig } from "../config";
import { parseDuration, getAgentConfig, getDefaultAgentId } from "../config/parsing";
import { loadHeartbeatFile, isHeartbeatFileEmpty } from "../agents/loader";
import type { SessionOutputContext } from "../protocol/channel";
import type { Gateway } from "./do";

// Token to indicate no action needed
export const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";

// Max chars for OK suppression (don't deliver short acks)
export const DEFAULT_ACK_MAX_CHARS = 300;

export type HeartbeatReason =
  | "interval" // Scheduled timer
  | "manual" // Manual trigger
  | "cron" // Cron job completion
  | "exec-event"; // Async execution completed

export type HeartbeatResult = {
  agentId: string;
  sessionKey: string;
  reason: HeartbeatReason;
  timestamp: number;

  // What happened
  skipped?: boolean;
  skipReason?: string;

  // Response
  responseText?: string;
  delivered?: boolean;
  deliveryTarget?: string;

  // Deduplication
  isDuplicate?: boolean;

  // Error
  error?: string;
};

/**
 * Check if current time is within active hours
 */
export function isWithinActiveHours(
  activeHours: HeartbeatConfig["activeHours"],
  now: Date = new Date(),
): boolean {
  if (!activeHours) return true;

  const { start, end, timezone } = activeHours;

  // Parse time strings (HH:mm)
  const [startHour, startMin] = start.split(":").map(Number);
  const [endHour, endMin] = end.split(":").map(Number);

  // Get current time in the appropriate timezone
  let currentHour: number;
  let currentMin: number;

  if (timezone && timezone !== "local") {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone === "user" ? undefined : timezone,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      currentHour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
      currentMin = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    } catch {
      // Fall back to local time if timezone invalid
      currentHour = now.getHours();
      currentMin = now.getMinutes();
    }
  } else {
    currentHour = now.getHours();
    currentMin = now.getMinutes();
  }

  const currentMins = currentHour * 60 + currentMin;
  const startMins = startHour * 60 + startMin;
  const endMins = endHour * 60 + endMin;

  // Handle overnight ranges (e.g., 22:00 - 06:00)
  if (startMins <= endMins) {
    return currentMins >= startMins && currentMins < endMins;
  } else {
    return currentMins >= startMins || currentMins < endMins;
  }
}

/**
 * Check if a response should be delivered or suppressed
 */
export function shouldDeliverResponse(text: string): {
  deliver: boolean;
  cleanedText: string;
} {
  // Strip HEARTBEAT_OK token from start/end
  let cleaned = text.trim();

  if (cleaned.startsWith(HEARTBEAT_OK_TOKEN)) {
    cleaned = cleaned.slice(HEARTBEAT_OK_TOKEN.length).trim();
  }
  if (cleaned.endsWith(HEARTBEAT_OK_TOKEN)) {
    cleaned = cleaned.slice(0, -HEARTBEAT_OK_TOKEN.length).trim();
  }

  // Strip leading/trailing punctuation that might be left
  cleaned = cleaned.replace(/^[:\-\s]+/, "").replace(/[:\-\s]+$/, "");

  // If empty or very short, don't deliver
  const ackMaxChars = DEFAULT_ACK_MAX_CHARS;
  if (cleaned.length === 0 || cleaned.length <= ackMaxChars) {
    return { deliver: false, cleanedText: cleaned };
  }

  return { deliver: true, cleanedText: cleaned };
}

/**
 * Get effective heartbeat config for an agent
 */
export function getHeartbeatConfig(
  globalConfig: GsvConfig,
  agentId: string,
): HeartbeatConfig {
  const agentConfig = getAgentConfig(globalConfig, agentId);
  const base = globalConfig.agents.defaultHeartbeat;
  const override = agentConfig.heartbeat;
  if (!override) return base;
  return {
    ...base,
    ...override,
  };
}

/**
 * Calculate next heartbeat time
 */
export function getNextHeartbeatTime(config: HeartbeatConfig): number | null {
  const interval = parseDuration(config.every);
  if (interval <= 0) return null; // Disabled

  return Date.now() + interval;
}

/**
 * State for heartbeat scheduling
 */
export type HeartbeatState = {
  agentId: string;
  nextHeartbeatAt: number | null;
  lastHeartbeatAt: number | null;
  lastHeartbeatText: string | null;
  lastHeartbeatSentAt: number | null;
};

export type HeartbeatRunReason = "interval" | "manual" | "cron";

export function resolveHeartbeatAgentIds(config: GsvConfig): string[] {
  const configured = config.agents.list
    .map((agent) => agent.id)
    .filter(Boolean);
  if (configured.length > 0) {
    return configured;
  }
  return [getDefaultAgentId(config)];
}

export function nextHeartbeatDueAtMs(gw: Gateway): number | undefined {
  let next: number | undefined;
  for (const state of Object.values(gw.heartbeatState)) {
    const candidate = state?.nextHeartbeatAt ?? undefined;
    if (!candidate) {
      continue;
    }
    if (next === undefined || candidate < next) {
      next = candidate;
    }
  }
  return next;
}

export async function scheduleHeartbeat(
  gw: Gateway,
): Promise<void> {
  const config = gw.getFullConfig();
  const activeAgentIds = new Set(resolveHeartbeatAgentIds(config));

  for (const existingAgentId of Object.keys(gw.heartbeatState)) {
    if (!activeAgentIds.has(existingAgentId)) {
      delete gw.heartbeatState[existingAgentId];
    }
  }

  for (const agentId of activeAgentIds) {
    const heartbeatConfig = getHeartbeatConfig(config, agentId);
    const nextTime = getNextHeartbeatTime(heartbeatConfig);

    const state = gw.heartbeatState[agentId] ?? {
      agentId,
      nextHeartbeatAt: null,
      lastHeartbeatAt: null,
      lastHeartbeatText: null,
      lastHeartbeatSentAt: null,
    };
    state.nextHeartbeatAt = nextTime;
    gw.heartbeatState[agentId] = state;
  }

  await gw.scheduleGatewayAlarm();
}

export async function runDueHeartbeats(
  gw: Gateway,
  now: number,
): Promise<void> {
  const config = gw.getFullConfig();

  for (const agentId of Object.keys(gw.heartbeatState)) {
    const state = gw.heartbeatState[agentId];
    if (!state.nextHeartbeatAt || state.nextHeartbeatAt > now) continue;

    const heartbeatConfig = getHeartbeatConfig(config, agentId);

    if (!isWithinActiveHours(heartbeatConfig.activeHours)) {
      console.log(
        `[Gateway] Heartbeat for ${agentId} skipped (outside active hours)`,
      );
      state.nextHeartbeatAt = getNextHeartbeatTime(heartbeatConfig);
      gw.heartbeatState[agentId] = state;
      continue;
    }

    await runHeartbeat(gw, agentId, heartbeatConfig, "interval");

    state.lastHeartbeatAt = now;
    state.nextHeartbeatAt = getNextHeartbeatTime(heartbeatConfig);
    gw.heartbeatState[agentId] = state;
  }
}

export async function runHeartbeat(
  gw: Gateway,
  agentId: string,
  config: HeartbeatConfig,
  reason: HeartbeatRunReason,
): Promise<HeartbeatResult> {
  console.log(
    `[Gateway] Running heartbeat for agent ${agentId} (reason: ${reason})`,
  );

  const result: HeartbeatResult = {
    agentId,
    sessionKey: "",
    reason,
    timestamp: Date.now(),
  };

  if (reason !== "manual" && config.activeHours) {
    const now = new Date();
    if (!isWithinActiveHours(config.activeHours, now)) {
      console.log(
        `[Gateway] Skipping heartbeat for ${agentId}: outside active hours`,
      );
      result.skipped = true;
      result.skipReason = "outside_active_hours";
      return result;
    }
  }

  if (reason !== "manual") {
    const heartbeatFile = await loadHeartbeatFile(env.STORAGE, agentId);
    if (!heartbeatFile.exists || isHeartbeatFileEmpty(heartbeatFile.content)) {
      console.log(
        `[Gateway] Skipping heartbeat for ${agentId}: HEARTBEAT.md is empty or missing`,
      );
      result.skipped = true;
      result.skipReason = heartbeatFile.exists
        ? "empty_heartbeat_file"
        : "no_heartbeat_file";
      return result;
    }
  }

  const lastActive = gw.lastActiveContext[agentId];
  if (reason !== "manual" && lastActive) {
    const sessionStub = env.SESSION.getByName(lastActive.sessionKey);
    const stats = await sessionStub.stats();
    if (stats.isProcessing || stats.queueSize > 0) {
      console.log(
        `[Gateway] Skipping heartbeat for ${agentId}: session is busy (queue: ${stats.queueSize})`,
      );
      result.skipped = true;
      result.skipReason = "session_busy";
      return result;
    }
  }

  const target = config.target ?? "last";
  const sessionKey = `agent:${agentId}:heartbeat:system:internal`;
  let deliveryContext: SessionOutputContext | null = null;

  if (target === "none") {
    console.log(`[Gateway] Heartbeat target=none, running silently`);
  } else if (target === "last" && lastActive) {
    deliveryContext = JSON.parse(
      JSON.stringify({
        channel: lastActive.channel,
        accountId: lastActive.accountId,
        peer: lastActive.peer,
        inboundMessageId: `heartbeat:${reason}:${Date.now()}`,
        agentId,
      }),
    );
    console.log(
      `[Gateway] Heartbeat target=last, delivering to ${lastActive.channel}:${lastActive.peer.id}`,
    );
  } else if (target === "last") {
    console.log(
      `[Gateway] Heartbeat target=last, no last active context, running silently`,
    );
  } else if (target !== "last" && target !== "none") {
    if (lastActive && lastActive.channel === target) {
      deliveryContext = JSON.parse(
        JSON.stringify({
          channel: lastActive.channel,
          accountId: lastActive.accountId,
          peer: lastActive.peer,
          inboundMessageId: `heartbeat:${reason}:${Date.now()}`,
          agentId,
        }),
      );
      console.log(`[Gateway] Heartbeat target=${target}, matched last active`);
    } else {
      console.log(
        `[Gateway] Heartbeat target=${target}, no matching context, running silently`,
      );
    }
  }

  result.sessionKey = sessionKey;

  const session = env.SESSION.getByName(sessionKey);
  const runId = crypto.randomUUID();

  if (deliveryContext) {
    gw.lastActiveContext[agentId] = {
      agentId,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
      peer: deliveryContext.peer,
      sessionKey,
      timestamp: Date.now(),
    };
    deliveryContext = {
      ...deliveryContext,
      agentId,
    };
  }
  const prompt = config.prompt;
  const tools = JSON.parse(JSON.stringify(gw.getAllTools()));
  const runtimeNodes = JSON.parse(JSON.stringify(gw.getRuntimeNodeInventory()));

  try {
    await session.chatSend(
      prompt,
      runId,
      tools,
      runtimeNodes,
      sessionKey,
      undefined,
      undefined,
      deliveryContext
        ? {
            channel: deliveryContext.channel,
            accountId: deliveryContext.accountId,
            peer: deliveryContext.peer,
            inboundMessageId: deliveryContext.inboundMessageId,
            agentId: deliveryContext.agentId,
          }
        : undefined,
    );
    console.log(`[Gateway] Heartbeat sent to session ${sessionKey}`);
  } catch (e) {
    console.error(`[Gateway] Heartbeat failed for ${agentId}:`, e);
    result.error = e instanceof Error ? e.message : String(e);
  }

  return result;
}

export async function triggerHeartbeat(
  gw: Gateway,
  agentId: string,
): Promise<{
  ok: boolean;
  message: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const config = gw.getConfig();
  const heartbeatConfig = getHeartbeatConfig(config, agentId);

  const result = await runHeartbeat(gw, agentId, heartbeatConfig, "manual");

  if (result.skipped) {
    return {
      ok: true,
      message: `Heartbeat skipped for agent ${agentId}: ${result.skipReason}`,
      skipped: true,
      skipReason: result.skipReason,
    };
  }

  if (result.error) {
    return {
      ok: false,
      message: `Heartbeat failed for agent ${agentId}: ${result.error}`,
    };
  }

  return {
    ok: true,
    message: `Heartbeat triggered for agent ${agentId} (session: ${result.sessionKey})`,
  };
}
