import type { GSVClient } from "@humansandmachines/gsv/client";
import type { FeedbackActivity, ProcHistoryRecordsResult } from "@humansandmachines/gsv/protocol";
import { FEEDBACK_ACTIVITY_MAX_LENGTH, FEEDBACK_ACTIVITY_MESSAGES } from "@humansandmachines/gsv/services/feedback";
import { transcriptRowsFromRecords } from "../chat/domain/typedHistory";

export function feedbackActivity(history: ProcHistoryRecordsResult): FeedbackActivity {
  const messageIds = new Set([...new Set(history.records.map(record => record.messageId))].slice(-FEEDBACK_ACTIVITY_MESSAGES));
  const records = history.records.filter(record => messageIds.has(record.messageId));
  const rows = transcriptRowsFromRecords(records);
  const text = rows.map(row => [
    `[${row.timestamp === null ? "unknown time" : new Date(row.timestamp).toISOString()}] ${row.role}${row.toolName ? ` · ${row.toolName}` : ""}${row.toolOutcome ? ` · ${row.toolOutcome}` : ""}`,
    ...(row.thinking ?? []).map(thinking => `Thinking: ${thinking}`),
    ...(row.toolArgs ? [`Arguments: ${JSON.stringify(row.toolArgs, null, 2)}`] : []),
    row.event ? JSON.stringify(row.event, null, 2) : row.text,
  ].filter(Boolean).join("\n")).join("\n\n");
  const truncated = text.length > FEEDBACK_ACTIVITY_MAX_LENGTH;
  const marker = "[Earlier activity omitted to fit the report]\n\n";
  return {
    pid: history.pid, messageCount: messageIds.size, truncated,
    text: truncated ? marker + text.slice(-(FEEDBACK_ACTIVITY_MAX_LENGTH - marker.length)) : text,
  };
}

export async function loadShipActivity(client: Pick<GSVClient, "request">, signal: AbortSignal): Promise<FeedbackActivity> {
  signal.throwIfAborted();
  const options = { signal };
  const { data: { conversation } } = await client.request("conversation.ship", {}, options);
  signal.throwIfAborted();
  const { data: history } = await client.request("proc.history", {
    pid: conversation.handlerPid, format: 2, tail: true, limit: FEEDBACK_ACTIVITY_MESSAGES,
  }, options);
  if (!history.ok) throw new Error(history.error);
  if (history.format !== 2) throw new Error("Typed Ship activity is unavailable");
  return feedbackActivity(history);
}
