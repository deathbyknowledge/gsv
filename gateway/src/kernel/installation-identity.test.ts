import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InstallationIdentity } from "../installation/identity";
import { getKernelByInstallationId } from "../installation/routing";
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
