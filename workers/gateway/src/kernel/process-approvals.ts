import { z } from "zod";
import { procHilRequestSchema } from "@humansandmachines/gsv/protocol";
import { sendFrameToProcess } from "../shared/utils";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";
import { processEventDeliverResultSchema } from "../protocol/process-frames";
import type { Kernel } from "./do";

export const processApprovalNoticeSchema = z.object({
  pid: z.string(), runId: z.string(), requestId: z.string(),
});
export type ProcessApprovalNotice = z.infer<typeof processApprovalNoticeSchema>;
type ApprovalNoticeHost = {
  installationId: Kernel["installationId"];
  procs: Pick<Kernel["procs"], "get">;
  ipcCalls: Pick<Kernel["ipcCalls"], "findPendingByTargetRun" | "get">;
  onboarding: Pick<Kernel["onboarding"], "managedWorkGate">;
  schedule: Kernel["schedule"];
};

/** The child owns the request; only a live same-owner delegation can notify its caller. */
export async function deliverProcessApprovalNotice(host: ApprovalNoticeHost, notice: ProcessApprovalNotice): Promise<void> {
  const child = host.procs.get(notice.pid);
  if (!child || child.activeRunId !== notice.runId || child.state !== "waiting_hil") return;
  const gate = await host.onboarding.managedWorkGate();
  if (!gate.allowed) {
    await host.schedule(new Date(Date.now() + MANAGED_LIFECYCLE_RECHECK_MS), "onProcessApprovalNotice", notice);
    return;
  }
  const response = await sendFrameToProcess(host.installationId, notice.pid, {
    type: "req", id: crypto.randomUUID(), call: "proc.history",
    args: { includeMessages: false },
  });
  if (response?.type === "res" && !response.ok && response.error.code === 410) return;
  const status = z.object({ ok: z.literal(true), pendingHil: z.nullable(procHilRequestSchema) });
  const parsed = response?.type === "res" && response.ok ? status.safeParse(response.data) : null;
  if (!parsed?.success) throw new Error("Could not read the pending process approval");
  const approval = parsed.data.pendingHil;
  if (!approval || approval.pid !== notice.pid || approval.runId !== notice.runId
    || approval.requestId !== notice.requestId) return;

  let targetPid = notice.pid;
  let targetRunId = notice.runId;
  const visited = new Set<string>([targetPid]);
  while (true) {
    const call = host.ipcCalls.findPendingByTargetRun({ uid: child.ownerUid, targetPid, targetRunId });
    if (!call?.sourceRunId || visited.has(call.sourcePid)) return;
    const source = host.procs.get(call.sourcePid);
    const currentChild = host.procs.get(notice.pid);
    if (!source || source.ownerUid !== child.ownerUid || call.ownerUid !== child.ownerUid
      || currentChild?.activeRunId !== notice.runId || currentChild.state !== "waiting_hil") return;
    visited.add(source.processId);
    const eventId = `approval:${notice.requestId}:${call.callId}`;
    const delivered = await sendFrameToProcess(host.installationId, source.processId, {
      type: "req", id: crypto.randomUUID(), call: "proc.event.deliver",
      args: {
        eventId,
        event: {
          kind: "process.approval", severity: "warn", audience: "model",
          payload: {
            ...notice, syscall: approval.syscall, target: approval.target,
            sourceRunId: call.sourceRunId, sourceCreatedAt: call.createdAt, observedAt: approval.createdAt,
          },
        },
      },
    });
    if (delivered?.type !== "res" || !delivered.ok) {
      if (delivered?.type === "res" && !delivered.ok && delivered.error.code === 410) return;
      throw new Error("Could not deliver the process approval notice");
    }
    const result = processEventDeliverResultSchema.safeParse(delivered.data);
    if (!result.success || result.data.eventId !== eventId) {
      throw new Error("Process approval acknowledgment did not match the delivery");
    }
    if (result.data.ignored || host.ipcCalls.get(call.callId)?.status !== "pending") return;
    targetPid = source.processId;
    targetRunId = call.sourceRunId;
  }
}
