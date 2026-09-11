import type { ConsoleAccount, ConsoleTarget } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { DevicePairingPanel } from "../shared/DevicePairingPanel";

export function ConnectPlace({ account, targets, ready, onClose, onConnected }: {
  account: ConsoleAccount | undefined;
  targets: readonly ConsoleTarget[];
  ready: boolean;
  onClose: () => void;
  onConnected: (id: string) => void;
}) {
  return <section class="fleet-connection" aria-label="Connect a place">
    <h3>Connect a place</h3>
    <p class="note">Give your Ship access to another computer or browser.</p>
    <DevicePairingPanel targets={targets} allowed={!!account && canConfigure(account, "sys.pair.create")} ready={ready} onClose={onClose} onConnected={onConnected} />
  </section>;
}
