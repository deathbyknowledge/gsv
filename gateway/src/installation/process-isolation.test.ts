import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bodyFromBytes,
  bodyToBytes,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "../process/do";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { getProcessByPid } from "../shared/utils";
import { createInstallationId, type InstallationId } from "./identity";
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
  it("isolates identical logical Process and media identities by installation", async () => {
    const firstId = createInstallationId();
    const secondId = createInstallationId();
    const pid = "proc:shared-logical-id";
    const first = await getProcessByPid(firstId, pid);
    const second = await getProcessByPid(secondId, pid);
    cleanupPrefixes.add(installationStoragePrefix(firstId));
    cleanupPrefixes.add(installationStoragePrefix(secondId));

    expect(first.id.toString()).not.toBe(second.id.toString());
    await initialize(first, firstId, pid, "first-agent");
    await initialize(second, secondId, pid, "second-agent");

    await expect(runInDurableObject(first, (process: Process) => ({
      installationId: process.installationId,
      username: process.identity.username,
    }))).resolves.toEqual({
      installationId: firstId,
      username: "first-agent",
    });
    await expect(runInDurableObject(second, (process: Process) => ({
      installationId: process.installationId,
      username: process.identity.username,
    }))).resolves.toEqual({
      installationId: secondId,
      username: "second-agent",
    });

    const firstUpload = await writeMedia(first, firstId, pid, [1, 2, 3]);
    const secondUpload = await writeMedia(second, secondId, pid, [4, 5, 6]);
    expect(firstUpload.key).toBe(secondUpload.key);

    const firstPhysicalKey = `${installationStoragePrefix(firstId)}${firstUpload.key}`;
    const secondPhysicalKey = `${installationStoragePrefix(secondId)}${secondUpload.key}`;
    expect([...new Uint8Array(
      await (await env.STORAGE.get(firstPhysicalKey))!.arrayBuffer(),
    )])
      .toEqual([1, 2, 3]);
    expect([...new Uint8Array(
      await (await env.STORAGE.get(secondPhysicalKey))!.arrayBuffer(),
    )])
      .toEqual([4, 5, 6]);
    expect(await env.STORAGE.head(firstUpload.key)).toBeNull();

    const firstRead = await first.recvFrame(firstId, request("proc.media.read", {
      key: firstUpload.key,
    })) as ResponseFrame<"proc.media.read">;
    const secondRead = await second.recvFrame(secondId, request("proc.media.read", {
      key: secondUpload.key,
    })) as ResponseFrame<"proc.media.read">;
    expect(firstRead.ok && firstRead.body
      ? [...await bodyToBytes(firstRead.body)]
      : null).toEqual([1, 2, 3]);
    expect(secondRead.ok && secondRead.body
      ? [...await bodyToBytes(secondRead.body)]
      : null).toEqual([4, 5, 6]);
  });

  it("rejects a route that disagrees with persisted Process ownership", async () => {
    const ownerId = createInstallationId();
    const foreignId = createInstallationId();
    const pid = "proc:route-mismatch";
    const process = await getProcessByPid(ownerId, pid);
    await initialize(process, ownerId, pid, "owner-agent");

    await expect(process.recvFrame(
      foreignId,
      request("proc.history", { pid }),
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: 409,
        message: "Process request installation does not match persisted identity",
      },
    });
  });

  it("requires managed Process initialization to name its installation", async () => {
    const installationId = createInstallationId();
    const pid = "proc:missing-installation-id";
    const process = await getProcessByPid(installationId, pid);

    await expect(process.recvFrame(
      installationId,
      request("proc.setidentity", {
        pid,
        identity: identity("agent"),
      }),
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: 409,
        message: "proc.setidentity requires installationId",
      },
    });
  });

  it("cancels a rejected initialization body", async () => {
    const installationId = createInstallationId();
    const pid = "proc:invalid-installation-id";
    const process = await getProcessByPid(installationId, pid);

    await runInDurableObject(process, async (instance: Process) => {
      const cancel = vi.fn();
      await expect(instance.recvFrame(installationId, {
        ...request("proc.setidentity", {
          installationId: "not a valid installation id",
          pid,
          identity: identity("agent"),
        }),
        body: {
          length: 1,
          stream: new ReadableStream({ cancel }),
        },
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 409,
          message: "proc.setidentity installationId is invalid",
        },
      });
      expect(cancel).toHaveBeenCalledWith(
        "proc.setidentity installationId is invalid",
      );
    });
  });
});

async function initialize(
  process: DurableObjectStub<Process>,
  installationId: InstallationId,
  pid: string,
  username: string,
): Promise<void> {
  const response = await process.recvFrame(
    installationId,
    request("proc.setidentity", {
      installationId,
      pid,
      identity: identity(username),
    }),
  );
  expect(response).toMatchObject({ ok: true, data: { ok: true } });
}

async function writeMedia(
  process: DurableObjectStub<Process>,
  installationId: InstallationId,
  pid: string,
  bytes: number[],
): Promise<{ key: string }> {
  const response = await process.recvFrame(installationId, {
    ...request("proc.media.write", {
      pid,
      type: "document",
      mimeType: "application/octet-stream",
      mediaId: "shared-media",
    }),
    body: bodyFromBytes(new Uint8Array(bytes)),
  }) as ResponseFrame<"proc.media.write">;
  if (!response.ok || !response.data?.ok) {
    throw new Error(response.ok
      ? response.data?.error ?? "media write failed"
      : response.error.message);
  }
  return response.data.media;
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

function request(call: string, args: unknown): RequestFrame {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame;
}
