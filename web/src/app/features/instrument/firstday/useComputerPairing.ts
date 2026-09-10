import { useEffect, useRef, useState } from "preact/hooks";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { CreateMachineNodeTokenInput, IssuedMachineNodeToken } from "../../../services/system/consoleService";
import { defaultMachineName, expiresAtFromDays, machineDeviceIdFromName } from "../../../services/machines/machineProvision";
import { uniqueDeviceId, type ComputerOs } from "./firstdayModel";

type ComputerPairingOperations = {
  create(input: CreateMachineNodeTokenInput): Promise<IssuedMachineNodeToken>;
  revoke: GSVClient["sys"]["token"]["revoke"];
};
type ComputerPairingState = {
  os: ComputerOs | null;
  issued: { os: ComputerOs; deviceId: string; token: IssuedMachineNodeToken } | null;
  pending: boolean;
  error: string;
};

/** Keep the displayed credential until revocation succeeds; serialize OS changes and late issuance cleanup. */
export function useComputerPairing(operations: ComputerPairingOperations, taken: readonly string[]) {
  const [state, setState] = useState<ComputerPairingState>({ os: null, issued: null, pending: false, error: "" });
  const current = useRef(state);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const publish = (next: ComputerPairingState) => {
    current.current = next;
    if (mounted.current) setState(next);
  };
  const choose = async (os: ComputerOs) => {
    const previous = current.current;
    if (!mounted.current || previous.pending || previous.issued?.os === os) return;
    publish({ ...previous, pending: true, error: "" });
    try {
      if (previous.issued) {
        await operations.revoke({ tokenId: previous.issued.token.tokenId, reason: "Computer selection changed" });
      }
      publish({ ...current.current, os, issued: null });
      if (!mounted.current) return;
      const deviceId = uniqueDeviceId(machineDeviceIdFromName(defaultMachineName(os)), taken);
      const token = await operations.create({ deviceId, label: defaultMachineName(os), expiresAt: expiresAtFromDays(30) });
      if (mounted.current) publish({ ...current.current, issued: { os, deviceId, token } });
      else await operations.revoke({ tokenId: token.tokenId, reason: "Connection closed before the pairing key was displayed" });
    } catch (cause) {
      publish({ ...current.current, error: cause instanceof Error ? cause.message : "Could not prepare the pairing key. Try again." });
    } finally {
      publish({ ...current.current, pending: false });
    }
  };

  return { ...state, choose };
}
