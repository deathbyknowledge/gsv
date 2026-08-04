import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";
import { accountIdentity } from "./accounts";
import {
  ensureMasterControlAgent,
  ensurePersonalAgent,
  masterControlUsername,
  MASTER_CONTROL_DISPLAY_NAME,
} from "./agents";
import type { KernelContext } from "./context";

export function masterControlProcessId(ownerUid: number): string {
  return `proc:master-control:${ownerUid}`;
}

/** Ensure the owner has one durable process performing the Master Control role. */
export async function ensureMasterControlProcess(
  ownerUid: number,
  ctx: KernelContext,
): Promise<string> {
  const pid = masterControlProcessId(ownerUid);
  const existing = ctx.procs.get(pid);
  if (existing) {
    if (
      existing.ownerUid !== ownerUid
      || existing.username !== masterControlUsername(ownerUid)
      || !existing.interactive
    ) {
      throw new Error(`Master Control process identity mismatch: ${pid}`);
    }
    return pid;
  }

  const owner = ctx.auth.getPasswdByUid(ownerUid);
  if (!owner) {
    throw new Error(`Master Control owner does not exist: uid=${ownerUid}`);
  }
  const ownerIdentity = accountIdentity(ctx.auth, owner);
  await ensurePersonalAgent(ctx, ownerIdentity);
  const controller = await ensureMasterControlAgent(ctx, ownerIdentity);
  ctx.procs.spawn(pid, controller.identity, {
    ownerUid,
    interactive: true,
    label: MASTER_CONTROL_DISPLAY_NAME,
    cwd: controller.identity.cwd,
  });

  try {
    await initializeMasterControlProcess(pid, controller.identity);
  } catch (error) {
    try {
      await rollbackMasterControlProcess(pid, ctx);
    } catch (rollbackError) {
      throw new Error(
        `Failed to initialize Master Control: ${formatError(error)}; `
        + `rollback failed: ${formatError(rollbackError)}`,
      );
    }
    throw error;
  }
  return pid;
}

async function initializeMasterControlProcess(
  pid: string,
  identity: ProcessIdentity,
): Promise<void> {
  const request: RequestFrame = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity,
      interactive: true,
      title: MASTER_CONTROL_DISPLAY_NAME,
      autoTitle: false,
    },
  };
  const response = await sendFrameToProcess(pid, request) as ResponseFrame | null;
  if (!response || response.type !== "res" || response.id !== request.id) {
    throw new Error("Master Control initialization returned no valid response");
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  if ((response.data as { ok?: unknown } | undefined)?.ok !== true) {
    throw new Error("Master Control process rejected initialization");
  }
}

async function rollbackMasterControlProcess(
  pid: string,
  ctx: KernelContext,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const response = await sendFrameToProcess(pid, {
    type: "req",
    id: requestId,
    call: "proc.kill",
    args: { pid, archive: false },
  } as RequestFrame) as ResponseFrame | null;
  if (!response || response.type !== "res" || response.id !== requestId) {
    throw new Error("proc.kill returned no valid response");
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  if ((response.data as { ok?: unknown } | undefined)?.ok !== true) {
    throw new Error("proc.kill rejected rollback");
  }
  ctx.procs.kill(pid);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
