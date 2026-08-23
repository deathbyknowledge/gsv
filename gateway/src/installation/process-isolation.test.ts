import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  bodyFromBytes,
  type ArgsOf,
  type ProcessIdentity,
  type SyscallName,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "../process/do";
import type { RequestFrame } from "../protocol/frames";
import { getProcessByPid } from "../shared/utils";
import { processDurableObjectName } from "./routing";
import { installationStoragePrefix } from "./storage";

const cleanupPrefixes = new Set<string>();

afterEach(async () => {
  for (const prefix of cleanupPrefixes) {
    const objects = await env.STORAGE.list({ prefix });
    if (objects.objects.length > 0) {
      await env.STORAGE.delete(objects.objects.map((object) => object.key));
    }
  }
  cleanupPrefixes.clear();
});

describe("managed Process isolation", () => {
  it("isolates identical Process and media identities by installation", async () => {
    const firstId = createInstallationId();
    const secondId = createInstallationId();
    const pid = "proc:shared-logical-id";
    const first = await getProcessByPid(pid, firstId);
    const second = await getProcessByPid(pid, secondId);
    cleanupPrefixes.add(installationStoragePrefix(firstId));
    cleanupPrefixes.add(installationStoragePrefix(secondId));

    expect(first.id.toString()).not.toBe(second.id.toString());
    await initialize(first, "first-agent");
    await initialize(second, "second-agent");

    await expect(runInDurableObject(first, (process: Process, state) => ({
      installationId: process.installationId,
      pid: process.pid,
      username: process.identity.username,
      durableObjectName: state.id.name,
      persistedInstallationId: state.storage.kv.get("installation_id"),
    }))).resolves.toEqual({
      installationId: firstId,
      pid,
      username: "first-agent",
      durableObjectName: processDurableObjectName(firstId, pid),
      persistedInstallationId: undefined,
    });
    await expect(runInDurableObject(second, (process: Process, state) => ({
      installationId: process.installationId,
      pid: process.pid,
      username: process.identity.username,
      durableObjectName: state.id.name,
      persistedInstallationId: state.storage.kv.get("installation_id"),
    }))).resolves.toEqual({
      installationId: secondId,
      pid,
      username: "second-agent",
      durableObjectName: processDurableObjectName(secondId, pid),
      persistedInstallationId: undefined,
    });

    const firstUpload = await writeMedia(first, pid, [1, 2, 3]);
    const secondUpload = await writeMedia(second, pid, [4, 5, 6]);
    expect(firstUpload.key).toBe(secondUpload.key);

    const firstPhysicalKey = `${installationStoragePrefix(firstId)}${firstUpload.key}`;
    const secondPhysicalKey = `${installationStoragePrefix(secondId)}${secondUpload.key}`;
    const firstObject = await env.STORAGE.get(firstPhysicalKey);
    const secondObject = await env.STORAGE.get(secondPhysicalKey);
    if (!firstObject || !secondObject) {
      throw new Error("Expected installation-scoped media objects");
    }
    expect([...new Uint8Array(await firstObject.arrayBuffer())]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(await secondObject.arrayBuffer())]).toEqual([4, 5, 6]);
    expect(await env.STORAGE.head(firstUpload.key)).toBeNull();

  });
});

async function initialize(
  process: DurableObjectStub<Process>,
  username: string,
): Promise<void> {
  const response = await process.recvFrame(request("proc.setidentity", {
    identity: identity(username),
  }));
  expect(response).toMatchObject({ ok: true, data: { ok: true } });
}

async function writeMedia(
  process: DurableObjectStub<Process>,
  pid: string,
  bytes: number[],
): Promise<{ key: string }> {
  const response = await runInDurableObject(process, (instance: Process) => {
    // SAFETY: this isolation test invokes the private resource-ingress boundary directly.
    const processInstance = instance as any;
    return processInstance.storeIncomingResource({
      type: "document",
      mimeType: "application/octet-stream",
      mediaId: "shared-media",
    }, bodyFromBytes(new Uint8Array(bytes)));
  });
  if (!response.ok) {
    throw new Error(response.error);
  }
  expect(response.media.key).toContain(pid);
  return response.media;
}

function identity(username: string): ProcessIdentity {
  return {
    uid: 1000,
    gid: 1000,
    gids: [1000],
    username,
    home: `/home/${username}`,
    cwd: `/home/${username}`,
  };
}

function request<S extends SyscallName>(call: S, args: ArgsOf<S>): RequestFrame<S> {
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  };
  // SAFETY: call and args share the same syscall generic, preserving the mapped frame pair.
  return frame as RequestFrame<S>;
}

function createInstallationId(): string {
  return `inst_${crypto.randomUUID()}`;
}
