import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDeletionRequest, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import type { InstallationDeletionDiscoveryService, InstallationDeletionInspection, InstallationDeletionInventoryImport } from "@humansandmachines/gsv/services/lifecycle-discovery";
import type { InferenceExecutionService, InferenceExecutor } from "@humansandmachines/gsv/services/inference-execution";
import type { MailService } from "@humansandmachines/gsv/services/mail";
import { z } from "zod";

type ProbeEnvironment = { INFERENCE_SERVICE: InferenceExecutionService; MAIL_SERVICE: MailService;
  INFERENCE_EXECUTORS: { getByName(name: string): InferenceExecutor } };

/** Local-only external-store fixture. Real operators must supply their own evidence verifier. */
export default class LocalDeletionEvidence extends WorkerEntrypoint<ProbeEnvironment> {
  async verifyAdditionalEvidence(): Promise<boolean> { return true; }

  async fetch(request: Request): Promise<Response> {
    const { installationId } = z.object({ installationId: z.string() }).parse(await request.json());
    // Catch inside Workers so the assertions see owner failures, not Node proxy error serialization.
    return Response.json({
      late: await rejection(() => this.env.INFERENCE_EXECUTORS.getByName(installationId).generate({
        version: 1, installationId, logicalRequestId: "late-generation", actor: { localUid: 1000 },
        connection: { provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", apiKey: "", maxTokens: 16,
          contextWindowTokens: null, baseUrl: undefined, providerStyle: undefined, openAiCodex: undefined, reasoning: undefined },
        messages: [{ role: "user", content: "late fixture payload" }], timeoutMs: 10000, deadlineAt: Date.now() + 10000,
      })),
      inference: await rejection(() => this.env.INFERENCE_SERVICE.getExecutor(installationId)),
      mail: await rejection(() => this.env.MAIL_SERVICE.listIntakes({ installationId }, {})),
    });
  }
}

async function rejection<T>(operation: () => Promise<T>): Promise<string | null> {
  try { await operation(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** Runs the real owner, then simulates one lost reply. The actual Kernel is restarted by the test. */
export class GatewayFaultRelay extends WorkerEntrypoint<{ GATEWAY_REAL: InstallationDeletionService & InstallationDeletionDiscoveryService; LOSE_ERASE_REPLY: number }> {
  async inspectInstallationDeletion(input: InstallationDeletionInspection) { return this.env.GATEWAY_REAL.inspectInstallationDeletion(input); }
  async importInstallationDeletionInventory(input: InstallationDeletionInventoryImport) { return this.env.GATEWAY_REAL.importInstallationDeletionInventory(input); }
  async quiesceInstallation(input: InstallationDeletionRequest) { return this.env.GATEWAY_REAL.quiesceInstallation(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return this.env.GATEWAY_REAL.installationDeletionStatus(input); }
  async eraseInstallation(input: InstallationDeletionRequest) {
    const receipt = await this.env.GATEWAY_REAL.eraseInstallation(input);
    if (this.env.LOSE_ERASE_REPLY === 1) throw new Error("Local fixture lost the committed owner reply");
    return receipt;
  }
}
