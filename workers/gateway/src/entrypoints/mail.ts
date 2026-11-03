import { WorkerEntrypoint } from "cloudflare:workers";
import type { AdapterInstallationContext } from "../adapter-interface";
import type {
  BinaryBody,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailLookup,
  ManagedOutboundMailReference,
} from "@humansandmachines/gsv/protocol";
import type { MailGatewayService } from "@humansandmachines/gsv/services/mail";
import { resolveAdapterInstallationId } from "../installation/admission";
import { managedInstallationWorkGate } from "../installation/lifecycle";
import { getKernelByInstallationId } from "../installation/routing";
import type { GatewayEnv } from "../runtime-env";

export class GatewayEntrypoint
  extends WorkerEntrypoint<GatewayEnv>
  implements MailGatewayService
{
  async acceptInboundMail(
    installation: AdapterInstallationContext,
    metadata: ManagedInboundMailMetadata,
    body: BinaryBody,
  ): Promise<ManagedInboundMailAccepted> {
    try {
      const installationId = resolveAdapterInstallationId(this.env, installation);
      const gate = await managedInstallationWorkGate(this.env, installationId);
      if (!gate.allowed) throw new Error(gate.message);
      const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
      return await kernel.acceptManagedInboundMail(metadata, body);
    } finally {
      if (!body.stream.locked) {
        await body.stream.cancel("Managed mail Gateway request completed").catch(() => {});
      }
    }
  }

  async completeInboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedInboundMailCompletion,
  ): Promise<void> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const gate = await managedInstallationWorkGate(this.env, installationId);
    if (!gate.allowed) throw new Error(gate.message);
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    await kernel.completeManagedInboundMail(completion);
  }

  async resolveOutboundMailReference(
    installation: AdapterInstallationContext,
    lookup: ManagedOutboundMailLookup,
  ): Promise<ManagedOutboundMailReference | null> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const gate = await managedInstallationWorkGate(this.env, installationId);
    if (!gate.allowed) throw new Error(gate.message);
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return await kernel.resolveOutboundMailReference(lookup);
  }

  async claimOutboundMail(
    installation: AdapterInstallationContext,
    reference: ManagedOutboundMailReference,
  ): Promise<ManagedOutboundMailClaimOutcome> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const gate = await managedInstallationWorkGate(this.env, installationId);
    if (!gate.allowed) throw new Error(gate.message);
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return await kernel.claimManagedOutboundMail(reference);
  }

  async completeOutboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedOutboundMailCompletion,
  ): Promise<void> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const directory = this.env.INSTALLATION_DIRECTORY;
    const result = await directory.resolveInstallation(installationId);
    if (!result.found) return;
    if (result.installationId !== installationId) {
      throw new Error("Managed installation identity does not match directory state");
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    await kernel.completeManagedOutboundMail(completion);
  }
}
