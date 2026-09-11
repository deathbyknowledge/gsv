import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type { ProcessScheduleDeliverArgs } from "../protocol/process-frames";
import { normalizeOptionalString } from "../process/internal/messages";
import { formatReplyDestinationForContext } from "./context-origin";

export function formatScheduleEventMessage(value: ProcessScheduleDeliverArgs): string {
  const scheduleId = normalizeOptionalString(value.scheduleId);
  const scheduleName = normalizeOptionalString(value.scheduleName);
  const message = normalizeOptionalString(value.message) ?? "Scheduled event fired.";
  const scheduledAtMs = value.scheduledAtMs !== undefined && value.scheduledAtMs !== null
    && Number.isFinite(value.scheduledAtMs)
    ? value.scheduledAtMs
    : null;
  const firedAtMs = Number.isFinite(value.firedAtMs) ? value.firedAtMs : Date.now();
  const lines = [scheduleName ? `Schedule \`${scheduleName}\` fired.` : "Schedule fired."];
  if (scheduleId) lines.push(`ID: \`${scheduleId}\``);
  if (value.replyTo) {
    const replyDestination = formatReplyDestinationForContext({
      kind: "scheduler", scheduleId: value.scheduleId, replyTo: value.replyTo,
    });
    lines.push(`Reply destination: ${replyDestination.description}.`);
  }
  if (scheduledAtMs !== null) lines.push(`Scheduled: ${new Date(scheduledAtMs).toISOString()}`);
  lines.push(`Fired: ${new Date(firedAtMs).toISOString()}`, "", message);

  const data = jsonValueSchema.safeParse(value.data);
  if (data.success) lines.push("", "Data:", "```json", JSON.stringify(data.data, null, 2), "```");
  return lines.join("\n");
}
