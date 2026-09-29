import type { ProcHistoryArchivedRecord, ProcHistoryRecord } from "@humansandmachines/gsv/protocol";

/** The shell exposes every record, including notes and person-only notices. */
export function renderProcHistoryRecords(
  records: readonly (ProcHistoryRecord | ProcHistoryArchivedRecord)[],
  maxContentChars?: number,
): string[] {
  const lines: string[] = [];
  for (const record of records) {
    let label: string;
    let content: string;
    switch (record.kind) {
      case "message":
        label = `message ${record.payload.direction}`;
        content = record.payload.text;
        if (record.payload.media.length > 0) content += `\nMedia: ${JSON.stringify(record.payload.media)}`;
        break;
      case "note":
        label = "note";
        content = [
          ...record.payload.thinking.map((block) => block.redacted ? "[redacted thinking]" : block.thinking),
          record.payload.text,
        ].filter(Boolean).join("\n");
        if (record.payload.media?.length) content += `\nMedia: ${JSON.stringify(record.payload.media)}`;
        break;
      case "call":
        label = `call ${record.payload.tool} call=${record.payload.callId}`;
        if (record.payload.syscall !== null) label += ` syscall=${record.payload.syscall}`;
        if (record.payload.target !== null) label += ` target=${record.payload.target}`;
        content = JSON.stringify(record.payload.args, null, 2);
        break;
      case "result":
        label = `result ${record.payload.tool} ${record.payload.outcome} call=${record.payload.callId ?? "unknown"}`;
        // JSON output is already typed; literal strings stay readable without interpreting their contents.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof
        content = typeof record.payload.output === "string"
          ? record.payload.output
          : JSON.stringify(record.payload.output, null, 2);
        if (record.payload.error) content += `\nError: ${JSON.stringify(record.payload.error)}`;
        if (record.payload.media.length > 0) content += `\nMedia: ${JSON.stringify(record.payload.media)}`;
        if (record.payload.resources.length > 0) content += `\nResources: ${JSON.stringify(record.payload.resources)}`;
        break;
      case "event":
        label = `event ${record.payload.kind} severity=${record.payload.severity} audience=${record.payload.audience}`;
        content = JSON.stringify(record.payload.payload, null, 2);
        break;
    }
    const run = record.runId === null ? "" : ` run=${record.runId}`;
    const timestamp = record.createdAt === undefined ? "-" : new Date(record.createdAt).toISOString();
    lines.push(`[#${record.messageId}:${record.index}] ${label} ${timestamp}${run}`);
    lines.push(maxContentChars !== undefined && content.length > maxContentChars
      ? `${content.slice(0, maxContentChars)}\n...[truncated ${content.length - maxContentChars} chars; use --full or --json to inspect all content]`
      : content);
    lines.push("");
  }
  return lines;
}
