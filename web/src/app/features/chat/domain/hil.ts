import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

type HilWireValue = string | number | boolean | null | HilWireValue[] | HilWireRecord;
type HilWireRecord = { [key: string]: HilWireValue };
const hilWireValueSchema: z.ZodType<HilWireValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(hilWireValueSchema),
  z.record(z.string(), hilWireValueSchema),
]));
const hilRequestSchema = z.object({
  pid: z.string(),
  requestId: z.string(),
  runId: z.string(),
  callId: z.string(),
  toolName: z.string(),
  syscall: z.string(),
  target: z.string(),
  args: z.record(z.string(), hilWireValueSchema).optional(),
  createdAt: z.number().finite().optional(),
});

export function normalizeHilRequest<T>(value: T): ProcHilRequest | null {
  const parsed = hilRequestSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const request = parsed.data;
  if (!request.pid.trim() || !request.requestId.trim() || !request.runId.trim()
    || !request.callId.trim() || !request.toolName.trim() || !request.syscall.trim()
    || !request.target) {
    return null;
  }
  return {
    pid: request.pid,
    requestId: request.requestId,
    runId: request.runId,
    callId: request.callId,
    toolName: request.toolName,
    syscall: request.syscall,
    target: request.target,
    args: request.args ?? {},
    createdAt: request.createdAt ?? Date.now(),
  };
}
