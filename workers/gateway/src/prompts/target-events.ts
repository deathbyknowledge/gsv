import type { ProcHistoryEventPayload } from "@humansandmachines/gsv/protocol";

export function formatTargetConnectionEvent(payload: ProcHistoryEventPayload<"target.connection">): string {
  return `Target \`${payload.targetId}\` ${payload.event}.`;
}
