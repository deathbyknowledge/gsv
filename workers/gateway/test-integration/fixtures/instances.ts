import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { CloudInstance, SysInstanceListResult } from "@humansandmachines/gsv/protocol";
import type { InstallationInstances, InstanceActor, InstanceTargetRequest, InstanceTargetResponse } from "@humansandmachines/gsv/services/instances";
import type { IntegrationState } from "./dependencies";

// A ready, owned browser without any paid provisioning or website access.
const instance: CloudInstance = {
  instanceId: "fixture-instance", targetId: "cloud-browser", startRequestId: "fixture-start", ownerUid: 1000,
  templateId: "browser", templateRevision: "1", kind: "browser", implements: ["shell.exec"], label: "Cloud browser",
  state: "ready", revision: 1, createdAt: 0, expiresAt: 4_000_000_000_000,
};

class IntegrationInstanceTarget extends RpcTarget implements Pick<InstallationInstances, "list" | "execute"> {
  constructor(private readonly state: DurableObjectStub<IntegrationState>) { super(); }

  async list(actor: InstanceActor): Promise<SysInstanceListResult> {
    return { instances: actor.ownerUid === instance.ownerUid ? [instance] : [], handoffs: [], usage: {
      periodStartsAt: 0, periodEndsAt: instance.expiresAt, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2,
    } };
  }

  async execute(actor: InstanceActor, instanceId: string, frame: InstanceTargetRequest): Promise<InstanceTargetResponse> {
    if (actor.ownerUid !== instance.ownerUid || instanceId !== instance.instanceId) throw new Error("Unknown browser");
    if (frame.call !== "shell.exec") throw new Error("Unsupported fixture operation");
    await this.state.recordInstanceCall(frame.call);
    return { type: "res", id: frame.id, ok: true, data: { status: "completed", output: "browser command completed", exitCode: 0 } };
  }
}

export class IntegrationInstances extends WorkerEntrypoint<{ INTEGRATION_STATE: DurableObjectNamespace<IntegrationState> }> {
  async getInstallation(installationId: string): Promise<IntegrationInstanceTarget> {
    if (installationId !== "inst_integration_default") throw new Error("Unknown installation");
    return new IntegrationInstanceTarget(this.env.INTEGRATION_STATE.getByName("integration-recorder"));
  }
}
