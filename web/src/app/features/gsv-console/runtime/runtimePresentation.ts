import type { StatusTone } from "../../../components/ui/StatusDot";
import {
  detailRow,
  listRowStatusForTone,
  liveRows,
} from "../components/consoleDetailRows";
import type { ConsoleDetailSection } from "../components/ConsoleDetailPage";
import { compactText, formatAge, uidLabel } from "../domain/consoleFormat";
import type { ConsoleProcess } from "../domain/consoleModels";

function isQueuedProcess(process: ConsoleProcess): boolean {
  return process.state === "queued" || process.queuedCount > 0;
}

export function toneForProcess(process: ConsoleProcess): StatusTone {
  if (process.state === "running") return "live";
  if (isQueuedProcess(process)) return "update";
  if (process.state === "unknown") return "warn";
  return "idle";
}

export function statusForProcess(process: ConsoleProcess): string {
  if (process.state === "running") return "RUNNING";
  if (isQueuedProcess(process)) return "QUEUED";
  if (process.state === "unknown") return "UNKNOWN";
  return "IDLE";
}

export function processSub(process: ConsoleProcess): string {
  return process.username || uidLabel(process.uid) || process.pid;
}

export function processBlurb(process: ConsoleProcess): string {
  return compactText(
    [process.username, process.profile, process.cwd],
    "Process runtime state and active conversation context.",
  );
}

export function processDetailSections(process: ConsoleProcess): ConsoleDetailSection[] {
  return [
    {
      title: "PROCESS",
      meta: statusForProcess(process),
      rows: liveRows([
        detailRow("pid", "PROCESS ID", process.pid),
        detailRow("state", "STATE", process.rawState || statusForProcess(process), {
          status: listRowStatusForTone(toneForProcess(process)),
          statusLabel: statusForProcess(process),
        }),
        detailRow("owner", "OWNER", process.username || uidLabel(process.uid)),
        detailRow("profile", "PROFILE", process.profile),
        detailRow("workspace", "WORKSPACE", process.cwd),
        detailRow("interactive", "INTERACTIVE", process.interactive),
      ]),
    },
    {
      title: "RUN",
      meta: process.activeRunId ? "ACTIVE" : process.queuedCount > 0 ? "QUEUED" : "IDLE",
      rows: liveRows([
        detailRow("active-run", "ACTIVE RUN", process.activeRunId),
        detailRow("conversation", "CONVERSATION", process.activeConversationId),
        detailRow("queued", "QUEUED MESSAGES", process.queuedCount),
        detailRow("created", "CREATED", process.createdAt === null ? "" : formatAge(process.createdAt)),
        detailRow("last-active", "LAST ACTIVE", process.lastActiveAt === null ? "" : formatAge(process.lastActiveAt)),
      ]),
    },
  ];
}
