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

export function iconForProcess(process: ConsoleProcess): string {
  return process.interactive ? "chat" : "list";
}

export function processSub(process: ConsoleProcess): string {
  return compactText(
    [process.username || uidLabel(process.uid), process.cwd],
    process.pid,
  );
}

export function processBlurb(process: ConsoleProcess): string {
  const owner = process.username || uidLabel(process.uid) || "unknown owner";
  return compactText(
    [`${statusForProcess(process).toLowerCase()} task`, owner, process.profile, process.cwd],
    "Process-backed task with conversation state and runtime controls.",
  );
}

export function processDetailSections(process: ConsoleProcess): ConsoleDetailSection[] {
  return [
    {
      title: "STATE",
      meta: statusForProcess(process),
      rows: liveRows([
        detailRow("state", "CURRENT STATE", process.rawState || statusForProcess(process), {
          status: listRowStatusForTone(toneForProcess(process)),
          statusLabel: statusForProcess(process),
        }),
        detailRow("active-run", "ACTIVE RUN", process.activeRunId),
        detailRow("queued", "QUEUED MESSAGES", process.queuedCount),
        detailRow("last-active", "LAST ACTIVE", process.lastActiveAt === null ? "" : formatAge(process.lastActiveAt)),
        detailRow("created", "CREATED", process.createdAt === null ? "" : formatAge(process.createdAt)),
      ]),
    },
    {
      title: "OWNER",
      meta: process.username || uidLabel(process.uid),
      rows: liveRows([
        detailRow("owner", "RUN AS", process.username || uidLabel(process.uid)),
        detailRow("profile", "PROFILE", process.profile),
        detailRow("interactive", "HIL APPROVALS", process.interactive),
        detailRow("parent", "PARENT TASK", process.parentPid),
      ]),
    },
    {
      title: "WORKSPACE",
      meta: process.activeConversationId ? "CONVERSATION" : "CONTEXT",
      rows: liveRows([
        detailRow("workspace", "WORKSPACE", process.cwd),
        detailRow("conversation", "CONVERSATION", process.activeConversationId),
        detailRow("pid", "PROCESS ID", process.pid),
      ]),
    },
  ];
}
