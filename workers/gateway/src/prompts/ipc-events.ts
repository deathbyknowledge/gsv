import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { ipcReplyPayloadSchema, nonEmptyStringSchema } from "../process/internal/schemas";
import { parseOptionalJsonObject } from "../process/internal/messages";
import { parseStoredProcessMedia } from "../process/media";
import { describeStoredProcessMedia } from "../process/history/media-renderer";

export function formatIpcReplyMessage(
  signal: string,
  payload: Parameters<typeof ipcReplyPayloadSchema.parse>[0],
): string {
  const record = ipcReplyPayloadSchema.parse(payload);
  const callId = record.callId ?? "unknown";
  const targetPid = record.targetPid ?? "unknown";
  const error = record.error ?? null;
  const response = record.response;
  const responseRecord = parseOptionalJsonObject(response);
  const responseText = nonEmptyStringSchema.safeParse(responseRecord?.text);
  const responseMedia = parseStoredProcessMedia(
    JSON.stringify(responseRecord?.media ?? null) ?? null,
  );
  const responseValue = jsonValueSchema.safeParse(response);
  const renderedResponse = responseValue.success ? JSON.stringify(responseValue.data, null, 2) ?? null : null;
  const overdue = signal === "ipc.overdue";

  const lines = [
    overdue
      ? `Delegated task to process \`${targetPid}\` is still running.`
      : signal === "ipc.timeout"
        ? `Delegated task to process \`${targetPid}\` timed out.`
        : callId === "unknown"
          ? `Process \`${targetPid}\` finished a task.`
          : `Process \`${targetPid}\` finished task \`${callId}\`.`,
  ];
  if ((overdue || signal === "ipc.timeout") && callId !== "unknown") {
    lines.push(`Task id: \`${callId}\`.`);
  }
  if (error) {
    lines.push("", "Error:", error);
  }
  if (overdue) {
    lines.push("", "The delegated process was not cancelled and remains responsible for the work.");
    if (record.nextCheckAt !== undefined) {
      lines.push(`Next check-in: ${new Date(record.nextCheckAt).toISOString()}.`);
    }
  }
  if (responseText.success) {
    lines.push("", "Result:", responseText.data);
  } else if (renderedResponse && responseMedia.length === 0) {
    lines.push("", "Response:", "```json", renderedResponse, "```");
  }
  if (responseMedia.length > 0) {
    lines.push("", "Attachments:", ...responseMedia.map((item) => `- ${describeStoredProcessMedia(item)}`));
  }
  return lines.join("\n");
}
