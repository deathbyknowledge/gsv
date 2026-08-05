import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleFsWrite } from "../drivers/native/fs";
import { handleShellExec } from "../drivers/native/shell";
import type { InstallationIdentity } from "../installation/identity";
import { getKernelByInstallationId } from "../installation/routing";
import { installationStoragePrefix } from "../installation/storage";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";

function createInstallationId(): string {
  return `inst_${crypto.randomUUID()}`;
}

describe("Kernel installation identity", () => {
  it("keeps two installation identities in separate Kernel objects", async () => {
    const firstId = createInstallationId();
    const secondId = createInstallationId();
    const first = await getKernelByInstallationId(env.KERNEL, firstId);
    const second = await getKernelByInstallationId(env.KERNEL, secondId);

    await runInDurableObject(first, (kernel: Kernel) => kernel.ensureInstallationIdentity({
      installationId: firstId,
      handle: "first",
      canonicalOrigin: "https://first.gsv.space",
    }));
    await runInDurableObject(second, (kernel: Kernel) => kernel.ensureInstallationIdentity({
      installationId: secondId,
      handle: "second",
      canonicalOrigin: "https://second.gsv.space",
    }));

    await expect(runInDurableObject(
      first,
      (kernel: Kernel) => kernel.getInstallationIdentity(),
    )).resolves.toMatchObject({
      installationId: firstId,
      handle: "first",
    });
    await expect(runInDurableObject(
      second,
      (kernel: Kernel) => kernel.getInstallationIdentity(),
    )).resolves.toMatchObject({
      installationId: secondId,
      handle: "second",
    });

    await runInDurableObject(first, (_kernel: Kernel, state) => {
      expect(state.storage.kv.get<InstallationIdentity>("install_identity")).toEqual({
        installationId: firstId,
        handle: "first",
        canonicalOrigin: "https://first.gsv.space",
      });
    });
  });

  it("rejects an identity that does not match the Kernel name", async () => {
    const kernelId = createInstallationId();
    const otherId = createInstallationId();
    const kernel = await getKernelByInstallationId(env.KERNEL, kernelId);

    await expect(runInDurableObject(kernel, (instance: Kernel) => (
      instance.ensureInstallationIdentity({
        installationId: otherId,
        handle: "other",
        canonicalOrigin: "https://other.gsv.space",
      })
    ))).rejects.toThrow("conflicts with Kernel name");
  });

  it("scopes filesystem syscalls and Shell storage by installation", async () => {
    const firstId = createInstallationId();
    const secondId = createInstallationId();
    const first = await getKernelByInstallationId(env.KERNEL, firstId);
    const second = await getKernelByInstallationId(env.KERNEL, secondId);
    const fsKey = `tmp/kernel-fs-${crypto.randomUUID()}.txt`;
    const shellKey = `tmp/kernel-shell-${crypto.randomUUID()}.txt`;
    const physicalKeys = [firstId, secondId].flatMap((installationId) => {
      const prefix = installationStoragePrefix(installationId);
      return [`${prefix}${fsKey}`, `${prefix}${shellKey}`];
    });

    const write = (
      kernel: DurableObjectStub<Kernel>,
      installationId: string,
      content: string,
    ) => runInDurableObject(kernel, async (instance: Kernel) => {
      await instance.ensureInstallationIdentity({
        installationId,
        handle: content,
        canonicalOrigin: `https://${content}.gsv.space`,
      });
      const context = buildKernelContext(instance);
      await expect(handleFsWrite({ path: `/${fsKey}`, content }, context))
        .resolves.toMatchObject({ ok: true });
      await expect(handleShellExec({
        input: `printf '${content}' > /${shellKey}`,
      }, context)).resolves.toMatchObject({ status: "completed" });
    });

    try {
      await write(first, firstId, "first");
      await write(second, secondId, "second");

      await expect(env.STORAGE.get(physicalKeys[0]).then((object) => object?.text()))
        .resolves.toBe("first");
      await expect(env.STORAGE.get(physicalKeys[1]).then((object) => object?.text()))
        .resolves.toBe("first");
      await expect(env.STORAGE.get(physicalKeys[2]).then((object) => object?.text()))
        .resolves.toBe("second");
      await expect(env.STORAGE.get(physicalKeys[3]).then((object) => object?.text()))
        .resolves.toBe("second");
      await expect(env.STORAGE.head(fsKey)).resolves.toBeNull();
      await expect(env.STORAGE.head(shellKey)).resolves.toBeNull();
    } finally {
      await env.STORAGE.delete(physicalKeys);
    }
  });

  it("does not silently replace persisted canonical identity", async () => {
    const installationId = createInstallationId();
    const kernel = await getKernelByInstallationId(env.KERNEL, installationId);
    await runInDurableObject(kernel, (instance: Kernel) => (
      instance.ensureInstallationIdentity({
        installationId,
        handle: "hank",
        canonicalOrigin: "https://hank.gsv.space",
      })
    ));

    await expect(runInDurableObject(kernel, (instance: Kernel) => (
      instance.ensureInstallationIdentity({
        installationId,
        handle: "hank-2",
        canonicalOrigin: "https://hank-2.gsv.space",
      })
    ))).rejects.toThrow("conflicts with persisted Kernel identity");
  });
});

function buildKernelContext(kernel: Kernel): KernelContext {
  return (kernel as unknown as {
    buildKernelContext(options: {
      identity: NonNullable<KernelContext["identity"]>;
    }): KernelContext;
  }).buildKernelContext({
    identity: {
      role: "user",
      process: {
        uid: 0,
        gid: 0,
        gids: [0],
        username: "root",
        home: "/root",
        cwd: "/root",
      },
      capabilities: ["fs.write", "shell.exec"],
    },
  });
}
