import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDirectoryResult, InstallationState } from "@humansandmachines/gsv/services/directory";
import type { PhoneChange, PhoneGatewayService, PhoneRealtimeSession, PhoneRealtimeSessionRequest, PhoneRealtimeSessions } from "@humansandmachines/gsv/services/phone";
export { default, CallCoordinator, PhoneCallObject } from "../src/index";

const states = new Map<string, InstallationState>();
const changes = new Map<string, PhoneChange[]>();

/** Every installation is active unless a test says otherwise. */
export class TestDirectory extends WorkerEntrypoint {
  async resolveInstallation(installationId: string): Promise<InstallationDirectoryResult> {
    return { found: true, installationId, handle: "test", canonicalOrigin: "https://test.example", state: states.get(installationId) ?? "active" };
  }
  async resolveHostname(): Promise<InstallationDirectoryResult> { return { found: false }; }
  async setState(installationId: string, state: InstallationState): Promise<void> { states.set(installationId, state); }
}

export class TestPhoneEvents extends WorkerEntrypoint implements PhoneGatewayService {
  async phoneChanged(change: PhoneChange): Promise<void> {
    changes.set(change.installationId, [...(changes.get(change.installationId) ?? []), change]);
  }
  async take(installationId: string): Promise<PhoneChange[]> {
    const value = changes.get(installationId) ?? [];
    changes.delete(installationId);
    return value;
  }
}

export class TestRealtimeSessions extends WorkerEntrypoint implements PhoneRealtimeSessions {
  async createRealtimeSession(input: PhoneRealtimeSessionRequest): Promise<PhoneRealtimeSession> {
    return { provider: "openai", model: input.model, url: "wss://realtime.example.test/v1/realtime", clientSecret: `secret-${input.callId}`, expiresAt: Date.now() + 60_000 };
  }
}
