import type { StatusTone } from "../../../components/ui/StatusDot";
import {
  detailRow,
  listRowStatusForTone,
  liveRows,
} from "../components/consoleDetailRows";
import type { ConsoleDetailSection } from "../components/ConsoleDetailPage";
import { compactText, formatAge, formatTokenLabel, uidLabel } from "../domain/consoleFormat";
import type { ConsoleTarget } from "../domain/consoleModels";

export function iconForTarget(target: ConsoleTarget): string {
  if (target.kind === "browser") return "bookmark";
  if (target.kind === "adapter") return "chat";
  return "computer";
}

export function targetSub(target: ConsoleTarget): string {
  return compactText([
    target.platform,
    target.version,
    target.ownerUsername ? `owner ${target.ownerUsername}` : "",
    target.description,
  ], target.deviceId);
}

export function toneForTarget(target: ConsoleTarget): StatusTone {
  return target.online ? "online" : "idle";
}

export function statusForTarget(target: ConsoleTarget): string {
  return target.online ? "ONLINE" : "OFFLINE";
}

export function machineBlurb(target: ConsoleTarget): string {
  return target.description || compactText(
    [target.platform, target.version, target.ownerUsername],
    "Machine target and declared capabilities.",
  );
}

export function machineDetailSections(target: ConsoleTarget): ConsoleDetailSection[] {
  return [
    {
      title: "MACHINE",
      meta: statusForTarget(target),
      rows: liveRows([
        detailRow("device", "DEVICE ID", target.deviceId),
        detailRow("status", "STATUS", statusForTarget(target), {
          status: listRowStatusForTone(toneForTarget(target)),
          statusLabel: statusForTarget(target),
        }),
        detailRow("platform", "PLATFORM", target.platform),
        detailRow("version", "VERSION", target.version),
        detailRow("owner", "OWNER", target.ownerUsername || uidLabel(target.ownerUid)),
        detailRow("last-seen", "LAST SEEN", target.lastSeenAt === null ? "" : formatAge(target.lastSeenAt)),
      ]),
    },
    {
      title: "CAPABILITIES",
      meta: `${target.implements.length}`,
      rows: liveRows([
        ...target.implements.map((capability) => detailRow(`capability:${capability}`, formatTokenLabel(capability), capability)),
        detailRow("description", "DESCRIPTION", target.description),
      ]),
    },
  ];
}
