/**
 * Heartbeat System
 * 
 * Periodic check-ins that allow the agent to:
 * - Read HEARTBEAT.md and follow its instructions
 * - Send proactive messages to channels
 * - Process scheduled tasks
 */

import { parseDuration, HeartbeatConfig, GsvConfig, DEFAULT_CONFIG, getAgentConfig } from "./config";

// Token to indicate no action needed
export const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";

// Max chars for OK suppression (don't deliver short acks)
export const DEFAULT_ACK_MAX_CHARS = 300;

export type HeartbeatReason = 
  | "interval"      // Scheduled timer
  | "manual"        // Manual trigger
  | "cron"          // Cron job completion
  | "exec-event";   // Async execution completed

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
      currentHour = Number(parts.find(p => p.type === "hour")?.value ?? 0);
      currentMin = Number(parts.find(p => p.type === "minute")?.value ?? 0);
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
export function shouldDeliverResponse(
  text: string,
): { deliver: boolean; cleanedText: string } {
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
