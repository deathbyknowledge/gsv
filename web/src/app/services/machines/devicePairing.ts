import { z } from "zod";
import { createPairingSecret, type SysPairCreateArgs } from "@humansandmachines/gsv/protocol";
import { GsvClientError, type GSVClient } from "@humansandmachines/gsv/client";
import { parseDeviceId } from "../../domain/deviceId";
import { machineDeviceIdFromName, type MachineProvisionPlatform } from "./machineProvision";

const storedSchema = z.object({
  draft: z.object({ label: z.string(), targetId: z.string(), customId: z.boolean(), replace: z.boolean().optional(), platform: z.enum(["mac", "linux", "windows", "browser"]) }),
  invitation: z.object({
    request: z.object({ id: z.string(), secret: z.string(), label: z.string(), targetId: z.string(), replace: z.boolean().optional() }),
    pairing: z.object({ id: z.string(), username: z.string(), targetId: z.string(), label: z.string(), createdAt: z.number(), expiresAt: z.number(), state: z.enum(["pending", "paired", "cancelled", "expired"]) }).nullable(),
  }).nullable(),
});
type StoredPairing = z.infer<typeof storedSchema>;
export type DevicePairingState = StoredPairing & { pending: boolean; error: string };
type PairingApi = Pick<GSVClient["sys"]["pair"], "create" | "list" | "cancel">;
type PairingStorage = { read(): string | null; write(value: string): void };
const creationRejectionSchema = z.object({ pairingCreate: z.literal("rejected") });

function emptyPairing(): StoredPairing {
  return { draft: { label: "", targetId: "", customId: false, platform: "mac" }, invitation: null };
}

/** The signed-in browser owns its invitation across panels, navigation, and reloads. */
export class DevicePairingSession {
  private state: DevicePairingState;
  private disposed = false;
  private listeners = new Set<() => void>();

  constructor(private readonly api: PairingApi, private readonly storage: PairingStorage) {
    this.state = { ...emptyPairing(), pending: false, error: "" };
    try {
      const raw = storage.read();
      if (raw) this.state = { ...storedSchema.parse(JSON.parse(raw)), pending: false, error: "" };
    } catch { this.state.error = "Could not restore pairing. Check that browser storage is available."; }
  }

  snapshot = (): DevicePairingState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose = (): void => { this.disposed = true; this.listeners.clear(); };

  setLabel(label: string, taken: readonly string[]): void {
    if (this.state.pending || this.state.invitation) return;
    const draft = { ...this.state.draft, label };
    if (!draft.customId) {
      const base = label.trim() ? machineDeviceIdFromName(label) : "";
      let candidate = base;
      for (let suffix = 2; candidate && taken.includes(candidate); suffix++) {
        candidate = `${base.slice(0, 48 - String(suffix).length - 1)}-${suffix}`;
      }
      draft.targetId = candidate;
    }
    this.save({ ...this.state, draft, error: "" });
  }

  setTargetId(targetId: string): void {
    if (this.state.pending || this.state.invitation) return;
    this.save({ ...this.state, draft: { ...this.state.draft, targetId, customId: true }, error: "" });
  }

  setPlatform(platform: MachineProvisionPlatform): void {
    this.save({ ...this.state, draft: { ...this.state.draft, platform } });
  }

  selectExisting(label: string, targetId: string, platform: MachineProvisionPlatform): boolean {
    if (this.state.pending) return false;
    const current = this.state.invitation;
    if (current && (!current.pairing || current.pairing.state === "pending" && current.pairing.expiresAt > Date.now())) return current.request.targetId === targetId;
    return this.save({ ...this.state, invitation: null, draft: { label, targetId, platform, customId: true, replace: true }, error: "" });
  }

  create = async (): Promise<void> => {
    if (this.disposed || this.state.pending) return;
    const { draft } = this.state;
    if (!draft.label.trim() || !parseDeviceId(draft.targetId)) return;
    const request: SysPairCreateArgs = this.state.invitation?.request ?? {
      id: crypto.randomUUID(), secret: createPairingSecret(), label: draft.label.trim(), targetId: draft.targetId.trim(),
    };
    if (draft.replace) request.replace = true;
    if (!this.save({ ...this.state, invitation: this.state.invitation ?? { request, pairing: null }, pending: true, error: "" })) return;
    try {
      const { pairing } = await this.api.create(request);
      if (!this.disposed) this.save({ ...this.state, invitation: { request, pairing }, pending: false });
    } catch (error) { this.fail(error instanceof Error ? error : null, "Could not create the invitation. Retry when connected."); }
  };

  refresh = async (): Promise<void> => {
    const current = this.state.invitation;
    if (!current?.pairing || current.pairing.state !== "pending" || this.state.pending || this.disposed) return;
    try {
      const { pairings } = await this.api.list({});
      if (this.disposed || this.state.pending || this.state.invitation !== current) return;
      const pairing = pairings.find((item) => item.id === current.request.id);
      if (pairing) this.save({ ...this.state, invitation: { ...current, pairing } });
    } catch (error) {
      if (!this.state.pending && this.state.invitation === current) this.fail(error instanceof Error ? error : null, "Could not check the invitation. Retry when connected.");
    }
  };

  cancel = async (): Promise<void> => {
    const current = this.state.invitation;
    if (!current || this.disposed || this.state.pending) return;
    if (current.pairing?.state === "paired") return;
    this.publish({ ...this.state, pending: true, error: "" });
    try {
      // Reconcile uncertain creation before cancelling its exact identity.
      await this.api.create(current.request);
      const { pairing } = await this.api.cancel({ id: current.request.id });
      if (!this.disposed) this.save({ ...this.state, invitation: { ...current, pairing }, pending: false });
    } catch (error) { this.fail(error instanceof Error ? error : null, "Could not cancel the invitation. Retry when connected."); }
  };

  startAnother = (): void => {
    if (this.state.pending || this.disposed) return;
    const pairing = this.state.invitation?.pairing;
    if (this.state.invitation && (!pairing || pairing.state === "pending" && pairing.expiresAt > Date.now())) return;
    const draft = pairing?.state === "paired" ? { ...emptyPairing().draft, platform: this.state.draft.platform } : this.state.draft;
    this.save({ ...emptyPairing(), draft, pending: false, error: "" });
  };

  private fail(error: Error | null, fallback: string): void {
    if (this.disposed) return;
    const state = { ...this.state, pending: false, error: error?.message ?? fallback };
    if (error instanceof GsvClientError && creationRejectionSchema.safeParse(error.details).success) {
      this.save({ ...state, invitation: null });
    } else this.publish(state);
  }

  private save(state: DevicePairingState): boolean {
    if (this.disposed) return false;
    try {
      this.storage.write(JSON.stringify({ draft: state.draft, invitation: state.invitation }));
      this.publish(state);
      return true;
    } catch {
      this.publish({ ...this.state, pending: false, error: "Could not save pairing in this browser. Check that storage is available and retry." });
      return false;
    }
  }

  private publish(state: DevicePairingState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
