import type { GSVClient } from "@humansandmachines/gsv/client";
import { encodeDevicePairingCode } from "@humansandmachines/gsv/protocol";
import { DevicePairingSession } from "../app/services/machines/devicePairing";
import { t } from "../app/i18n/locale";

export type MachineIdentity = { origin: string; username: string; targetId: string; label: string };
export type MachineSnapshot = {
  suggestedName: string;
  configured: MachineIdentity | null;
  pending: MachineIdentity | null;
  running: boolean;
  connected: boolean;
};
export type MachineCommand = { kind: "pair"; code: string } | { kind: "resume" } | { kind: "start" };
export type NativeMachine = {
  status(): Promise<MachineSnapshot>;
  command(command: MachineCommand): Promise<MachineSnapshot>;
};
type MachineState = { machine: MachineSnapshot | null; loading: boolean; busy: boolean; error: string };

/** One signed-in Desktop owns setup; Fleet keeps its separate invitation for other devices. */
export class DesktopMachineSession {
  private state: MachineState = { machine: null, loading: true, busy: false, error: "" };
  private disposed = false;
  private listeners = new Set<() => void>();
  readonly pairing: DevicePairingSession;

  constructor(
    readonly origin: string,
    readonly username: string,
    private readonly native: NativeMachine,
    api: Pick<GSVClient["sys"]["pair"], "create" | "list" | "cancel">,
    storage: { read(): string | null; write(value: string): void },
  ) {
    this.pairing = new DevicePairingSession(api, storage);
  }

  snapshot = (): MachineState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose = (): void => { this.disposed = true; this.pairing.dispose(); this.listeners.clear(); };
  matches = (identity: MachineIdentity): boolean => identity.origin === this.origin && identity.username === this.username;

  load = async (): Promise<void> => {
    if (this.disposed || this.state.busy) return;
    try {
      const machine = await this.native.status();
      if (this.disposed || this.state.busy) return;
      this.publish({ machine, loading: false, busy: false, error: "" });
      if (machine.configured && this.matches(machine.configured) && !machine.pending && !machine.connected) {
        await this.connect("", [], true);
      }
    } catch (error) {
      if (this.disposed || this.state.busy) return;
      this.publish({ ...this.state, loading: false,
        error: error instanceof Error ? error.message : t("desktop.machine.checkFailed") });
    }
  };

  connect = async (label: string, taken: readonly string[], existingOnly = false): Promise<boolean> => {
    if (this.disposed || this.state.busy) return false;
    this.publish({ ...this.state, busy: true, error: "" });
    try {
      const machine = await this.native.status();
      if (this.disposed) return false;
      this.publish({ ...this.state, machine });
      if ([machine.configured, machine.pending].some((identity) => identity && !this.matches(identity))) {
        throw new Error(t("desktop.machine.otherOwner"));
      }
      if (existingOnly && !machine.configured && !machine.pending) {
        this.publish({ machine, loading: false, busy: false, error: "" });
        return false;
      }
      let command: MachineCommand;
      if (machine.pending) command = { kind: "resume" };
      else if (machine.configured) command = { kind: "start" };
      else {
        await this.pairing.refresh();
        if (this.disposed) return false;
        const previous = this.pairing.snapshot().invitation?.pairing;
        if (previous && (previous.state !== "pending" || previous.expiresAt <= Date.now())) this.pairing.startAnother();
        this.pairing.setLabel(label, taken);
        await this.pairing.create();
        if (this.disposed) return false;
        const { invitation, error } = this.pairing.snapshot();
        if (error || !invitation?.pairing) throw new Error(error || t("desktop.machine.prepareFailed"));
        if (invitation.pairing.state !== "pending" || invitation.pairing.expiresAt <= Date.now()) {
          throw new Error(t("desktop.machine.invitationExpired"));
        }
        command = { kind: "pair", code: encodeDevicePairingCode(this.origin, invitation.pairing, invitation.request.secret) };
      }
      const result = await this.native.command(command);
      if (this.disposed) return false;
      this.publish({ machine: result, loading: false, busy: false,
        error: !existingOnly && !result.configured && !result.pending ? t("desktop.machine.connectAgain") : "" });
      return result.connected;
    } catch (error) {
      if (this.disposed) return false;
      // A failed service install can follow a committed pairing. Re-read the
      // native owner so Retry starts that service instead of creating a target.
      let machine = this.state.machine;
      try { machine = await this.native.status(); } catch { /* Retain the last confirmed identity. */ }
      this.publish({ machine, loading: false, busy: false,
        error: error instanceof Error ? error.message : t("desktop.machine.connectFailed") });
      return false;
    }
  };

  private publish(state: MachineState): void {
    if (this.disposed) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
