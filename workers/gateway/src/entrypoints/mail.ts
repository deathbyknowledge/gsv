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
import { kernelForSettlement, kernelForWork } from "../installation/admission";
import type { Kernel } from "../kernel/do";
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
      const kernel = await admittedKernel(this.env, installation);
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
    const kernel = await admittedKernel(this.env, installation);
    await kernel.completeManagedInboundMail(completion);
  }

  async resolveOutboundMailReference(
    installation: AdapterInstallationContext,
    lookup: ManagedOutboundMailLookup,
  ): Promise<ManagedOutboundMailReference | null> {
    const kernel = await admittedKernel(this.env, installation);
    return await kernel.resolveOutboundMailReference(lookup);
  }

  async claimOutboundMail(
    installation: AdapterInstallationContext,
    reference: ManagedOutboundMailReference,
  ): Promise<ManagedOutboundMailClaimOutcome> {
    const kernel = await admittedKernel(this.env, installation);
    return await kernel.claimManagedOutboundMail(reference);
  }

  async completeOutboundMail(
    installation: AdapterInstallationContext,
    completion: ManagedOutboundMailCompletion,
  ): Promise<void> {
    // Records the outcome of a send the Kernel already claimed, so it lands even after a restriction.
    const kernel = await kernelForSettlement(this.env, installation);
    await kernel?.completeManagedOutboundMail(completion);
  }
}

/** The Kernel for new mail work; a refusal fails the call with Accounts' reason. */
async function admittedKernel(
  env: GatewayEnv,
  installation: AdapterInstallationContext,
): Promise<DurableObjectStub<Kernel>> {
  const admission = await kernelForWork(env, installation);
  if (!admission.allowed) throw new Error(admission.message);
  return admission.kernel;
}
