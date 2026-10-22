import { z } from "zod";
import { GSVClient, GsvClientError } from "@humansandmachines/gsv/client";
import { createPairingCredential, decodeDevicePairingCode, type DevicePairingCode, type SysPairRedeemArgs, type SysPairRedeemResult } from "@humansandmachines/gsv/protocol";
import { loadConfig, saveConfig, type ExtensionConfig } from "../shared/config";

const PENDING_KEY = "gsvExtensionPendingPairing";
const pendingSchema = z.object({ code: z.string(), credential: z.string() });
const terminalRefusalSchema = z.object({ pairing: z.enum(["cancelled", "expired", "used", "unavailable"]) });
type PendingPairing = z.infer<typeof pendingSchema>;
type PairingOperations = {
  load(): Promise<PendingPairing | null>;
  save(value: PendingPairing | null): Promise<void>;
  config(): Promise<ExtensionConfig>;
  commit(config: ExtensionConfig): Promise<ExtensionConfig>;
  redeem(invite: DevicePairingCode, args: SysPairRedeemArgs): Promise<SysPairRedeemResult>;
};

const defaultOperations: PairingOperations = {
  load: async () => {
    const raw = await chrome.storage.local.get(PENDING_KEY);
    const parsed = pendingSchema.safeParse(raw[PENDING_KEY]);
    return parsed.success ? parsed.data : null;
  },
  save: async (value) => { if (value) await chrome.storage.local.set({ [PENDING_KEY]: value }); else await chrome.storage.local.remove(PENDING_KEY); },
  config: loadConfig,
  commit: saveConfig,
  redeem: (invite, args) => new GSVClient().requestOnce(invite.gatewayUrl, "sys.pair.redeem", args),
};

/** Persist the receiving credential before the one-use exchange; connection setup stays with the supervisor. */
export class BrowserPairing {
  private pending = false;
  private generation = 0;
  constructor(private readonly operations: PairingOperations = defaultOperations) {}
  get isPairing(): boolean { return this.pending; }
  get epoch(): number { return this.generation; }
  stop(): void { this.generation++; }

  async pair(code: string): Promise<ExtensionConfig> {
    if (this.pending) throw new Error("This browser is already connecting");
    this.pending = true;
    const generation = this.generation;
    const checkCurrent = () => { if (generation !== this.generation) throw new Error("Connecting stopped. Retry to finish connecting this browser."); };
    try {
      const initial = await this.operations.config();
      const previous = await this.operations.load();
      const selectedCode = code.trim() || previous?.code;
      if (!selectedCode) throw new Error("Copy an invitation from Ship's connect flow first.");
      const invite = decodeDevicePairingCode(selectedCode);
      if (previous && previous.code.trim() !== selectedCode) {
        throw new Error("Clear the field and retry to finish connecting with the previous invitation first.");
      }
      const pending = previous ?? { code: selectedCode, credential: createPairingCredential() };
      checkCurrent();
      await this.operations.save(pending);
      checkCurrent();
      let result: SysPairRedeemResult;
      try {
        result = await this.operations.redeem(invite, { id: invite.id, secret: invite.secret, credential: pending.credential });
      } catch (error) {
        if (error instanceof GsvClientError && terminalRefusalSchema.safeParse(error.details).success) await this.operations.save(null);
        throw error;
      }
      if (result.pairing.id !== invite.id || result.pairing.username !== invite.username || result.pairing.targetId !== invite.targetId || result.pairing.state !== "paired") {
        throw new Error("Ship returned a different connection than the invitation named");
      }
      const old = await this.operations.config();
      checkCurrent();
      if (JSON.stringify(old) !== JSON.stringify(initial)) throw new Error("Connection settings changed while connecting. Retry to apply this invitation.");
      const saved = await this.operations.commit({ ...old, gatewayUrl: invite.gatewayUrl, username: invite.username, deviceId: invite.targetId, token: pending.credential, autoConnect: true });
      await this.operations.save(null);
      checkCurrent();
      return saved;
    } finally { this.pending = false; }
  }
}
