import { WorkerEntrypoint } from "cloudflare:workers";
import type { AdapterInstallationContext } from "../adapter-interface";
import type {
  BinaryBody,
  ManagedInboundMailAccepted,
  ManagedInboundMailCompletion,
  ManagedInboundMailMetadata,
  ManagedTelegramGatewayService,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailCompletion,
  ManagedOutboundMailLookup,
  ManagedOutboundMailReference,
  UnlinkManagedTelegramIdentityInput,
  UnlinkManagedTelegramIdentityResult,
} from "@humansandmachines/gsv/protocol";
import type { MailGatewayService } from "@humansandmachines/gsv/services/mail";
import { resolveAdapterInstallationId } from "../installation/admission";
import { parseInstallationId } from "../installation/identity";
import { managedInstallationWorkGate } from "../installation/lifecycle";
import { getKernelByInstallationId } from "../installation/routing";
import type { GatewayEnv } from "../runtime-env";

export class GatewayEntrypoint
  extends WorkerEntrypoint<GatewayEnv>
  implements MailGatewayService, ManagedTelegramGatewayService
{
  async acceptInboundMail(
    installation: AdapterInstallationContext,
    metadata: ManagedInboundMailMetadata,
    body: BinaryBody,
  ): Promise<ManagedInboundMailAccepted> {
    return await this.acceptManagedInboundMail(installation, metadata, body);
  }

  async completeInboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedInboundMailCompletion,
  ): Promise<void> {
    await this.completeManagedInboundMail(installation, completion);
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
    return await this.claimManagedOutboundMail(installation, reference);
  }

  async completeOutboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedOutboundMailCompletion,
  ): Promise<void> {
    await this.completeManagedOutboundMail(installation, completion);
  }

  async acceptManagedInboundMail(
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

  async completeManagedInboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedInboundMailCompletion,
  ): Promise<void> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const gate = await managedInstallationWorkGate(this.env, installationId);
    if (!gate.allowed) throw new Error(gate.message);
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    await kernel.completeManagedInboundMail(completion);
  }

  async claimManagedOutboundMail(
    installation: AdapterInstallationContext,
    reference: ManagedOutboundMailReference,
  ): Promise<ManagedOutboundMailClaimOutcome> {
    const installationId = resolveAdapterInstallationId(this.env, installation);
    const gate = await managedInstallationWorkGate(this.env, installationId);
    if (!gate.allowed) throw new Error(gate.message);
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return await kernel.claimManagedOutboundMail(reference);
  }

  async completeManagedOutboundMail(
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

  async unlinkManagedTelegramIdentity(
    input: UnlinkManagedTelegramIdentityInput,
  ): Promise<UnlinkManagedTelegramIdentityResult> {
    if (!this.env.INSTALLATION_DIRECTORY) {
      throw new Error("Managed Telegram is not enabled");
    }
    const installationId = parseInstallationId(input?.installationId);
    const directory = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!directory.found || directory.installationId !== installationId) {
      return { removed: false };
    }
    const kernel = await getKernelByInstallationId(this.env.KERNEL, installationId);
    return await kernel.unlinkManagedTelegramIdentity({ ...input, installationId });
  }
}
