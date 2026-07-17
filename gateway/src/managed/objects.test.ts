import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildAppRunnerName } from "../protocol/app-session";
import { describeGatewayManagedObjects } from "./objects";

describe("gateway managed object descriptors", () => {
  it("classifies arbitrary provider IDs explicitly instead of skipping them", async () => {
    const processId = env.PROCESS.newUniqueId().toString();
    const appRunnerId = env.APP_RUNNER.newUniqueId().toString();
    const kernelId = env.KERNEL.newUniqueId().toString();

    await expect(describeGatewayManagedObjects(env, "process", [processId]))
      .resolves.toMatchObject({
        kind: "process",
        objects: [{
          providerId: processId,
          logicalName: null,
          classification: "uninitialized",
          lifecycle: { status: "uninitialized", epoch: 0 },
        }],
      });
    await expect(describeGatewayManagedObjects(env, "app_runner", [appRunnerId]))
      .resolves.toMatchObject({
        kind: "app_runner",
        objects: [{
          providerId: appRunnerId,
          logicalName: null,
          classification: "uninitialized",
        }],
      });
    await expect(describeGatewayManagedObjects(env, "kernel", [kernelId]))
      .resolves.toMatchObject({
        kind: "kernel",
        objects: [{
          providerId: kernelId,
          logicalName: null,
          classification: "uninitialized",
        }],
      });
  });

  it("reports Kernel identity from ctx.id and verifies singleton naming", async () => {
    const providerId = env.KERNEL.idFromName("singleton").toString();
    const result = await describeGatewayManagedObjects(env, "kernel", [providerId]);

    expect(result.objects).toEqual([{
      schemaVersion: 1,
      kind: "kernel",
      providerId,
      logicalName: "singleton",
      classification: "initialized",
      lifecycle: { status: "active", epoch: 0 },
    }]);
  });

  it("recovers AppRunner logical identity from its own persisted props", async () => {
    const runnerName = buildAppRunnerName(1000, "pkg-notes");
    const runner = env.APP_RUNNER.getByName(runnerName);
    await runner.ensureRuntime({
      packageId: "pkg-notes",
      packageName: "Notes",
      routeBase: "/apps/notes",
      entrypointName: "main",
      artifact: {
        hash: "sha256:test",
        mainModule: "index.ts",
        modulePaths: ["index.ts"],
      },
      appFrame: {
        uid: 1000,
        username: "alice",
        packageId: "pkg-notes",
        packageName: "Notes",
        entrypointName: "main",
        routeBase: "/apps/notes",
        issuedAt: 1,
        expiresAt: 2,
      },
    });

    const providerId = env.APP_RUNNER.idFromName(runnerName).toString();
    const result = await describeGatewayManagedObjects(env, "app_runner", [providerId]);
    expect(result.objects[0]).toMatchObject({
      providerId,
      logicalName: runnerName,
      classification: "initialized",
      lifecycle: { status: "active", epoch: 0 },
    });

    await runner.managedErase();
    await expect(describeGatewayManagedObjects(env, "app_runner", [providerId]))
      .resolves.toMatchObject({
        objects: [{
          logicalName: runnerName,
          classification: "erased",
          lifecycle: { status: "erased", epoch: 1 },
        }],
      });
  });

  it("persists Process lifecycle epochs and an erased classification", async () => {
    const pid = "managed-descriptor-process";
    const process = env.PROCESS.getByName(pid);
    await process.recvFrame({
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: {
        pid,
        identity: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
      },
    });
    const providerId = env.PROCESS.idFromName(pid).toString();

    await process.managedPause();
    await expect(describeGatewayManagedObjects(env, "process", [providerId]))
      .resolves.toMatchObject({
        objects: [{
          logicalName: pid,
          classification: "initialized",
          lifecycle: { status: "paused", epoch: 1 },
        }],
      });
    await process.managedResume();
    await process.managedErase();
    await expect(describeGatewayManagedObjects(env, "process", [providerId]))
      .resolves.toMatchObject({
        objects: [{
          logicalName: pid,
          classification: "erased",
          lifecycle: { status: "erased", epoch: 3 },
        }],
      });
  });
});
