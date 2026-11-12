import { z } from "zod";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { ComputerConnection } from "./computer-connection";
import { openedWorkspaceBytes, openWorkspace, sealedWorkspaceBytes, sealWorkspace, workspaceKey } from "./workspace-codec";

/** Where one computer's saved /workspace lives and the key that seals it. */
export type WorkspaceAddress = { objectKey: string; key: ArrayBuffer };
export type WorkspaceSave = { savedAt: number; bytes: number } | { error: string };

export const WORKSPACE_LIMIT_BYTES = 1 << 30;
const ARCHIVE = "/tmp/.gsv-workspace.tar.gz";
export const WORKSPACE_TIMEOUT_MS = 300_000;
const shellResultSchema = z.object({ status: z.string(), output: z.string().optional(), exitCode: z.number().optional() });
const sentSchema = z.union([z.object({ ok: z.literal(true), size: z.number().int().nonnegative() }), z.object({ ok: z.literal(false), error: z.string() })]);
const receivedSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]);

async function run(connection: ComputerConnection, input: string, deadlineAt: number): Promise<void> {
  const response = await connection.execute({ type: "req", id: crypto.randomUUID(), call: "shell.exec", args: { input, timeout: Math.max(1, deadlineAt - Date.now()) } }, deadlineAt);
  if (!response.ok) throw new Error(response.error.message);
  const result = shellResultSchema.parse(response.data);
  if (result.status !== "completed" || result.exitCode !== 0) throw new Error(`Workspace command failed: ${(result.output ?? "").slice(-2000)}`);
}

/** Archives /workspace inside the computer and stores the archive sealed. GNU tar's "file changed" status still saves. */
export async function saveWorkspace(connection: ComputerConnection, bucket: R2Bucket, address: WorkspaceAddress): Promise<{ bytes: number }> {
  const deadlineAt = Date.now() + WORKSPACE_TIMEOUT_MS;
  await run(connection, `rm -f ${ARCHIVE} || exit 2
[ -d /workspace ] || exit 2
tar -C /workspace -czf ${ARCHIVE} .
status=$?
[ "$status" -le 1 ]`, deadlineAt);
  const response = await connection.execute({ type: "req", id: crypto.randomUUID(), call: "fs.transfer.send", args: { path: ARCHIVE } }, deadlineAt);
  if (!response.ok) throw new Error(response.error.message);
  const sent = sentSchema.parse(response.data);
  const body = response.body;
  if (!sent.ok || !body || sent.size > WORKSPACE_LIMIT_BYTES) {
    await cancelBinaryBody(body, "Workspace archive was not stored");
    throw new Error(!sent.ok ? sent.error : !body ? "Workspace archive has no body" : `Workspace is larger than ${WORKSPACE_LIMIT_BYTES} bytes compressed`);
  }
  const key = await workspaceKey(address.key);
  const { readable, writable } = new FixedLengthStream(sealedWorkspaceBytes(sent.size));
  await Promise.all([
    bucket.put(address.objectKey, readable),
    body.stream.pipeThrough(sealWorkspace(key, address.objectKey)).pipeTo(writable),
  ]);
  return { bytes: sent.size };
}

/** Writes a saved archive into the computer and unpacks it into /workspace. */
export async function restoreWorkspace(connection: ComputerConnection, bucket: R2Bucket, address: WorkspaceAddress): Promise<void> {
  const deadlineAt = Date.now() + WORKSPACE_TIMEOUT_MS;
  const object = await bucket.get(address.objectKey);
  if (!object) throw new Error("Saved workspace is missing");
  const length = openedWorkspaceBytes(object.size);
  const stream = object.body.pipeThrough(openWorkspace(await workspaceKey(address.key), address.objectKey));
  const response = await connection.execute({ type: "req", id: crypto.randomUUID(), call: "fs.transfer.receive", args: { path: ARCHIVE }, body: { stream, length } }, deadlineAt);
  if (!response.ok) throw new Error(response.error.message);
  const received = receivedSchema.parse(response.data);
  if (!received.ok) throw new Error(received.error);
  await run(connection, `mkdir -p /workspace && tar -C /workspace -xzf ${ARCHIVE} && rm -f ${ARCHIVE}`, deadlineAt);
}
