import type { ConsoleAccount, ConsoleTarget } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { DevicePairingPanel } from "../shared/DevicePairingPanel";
import { useT } from "../../../i18n/locale";

export function ConnectPlace({ account, targets, ready, onClose, onConnected }: {
  account: ConsoleAccount | undefined;
  targets: readonly ConsoleTarget[];
  ready: boolean;
  onClose: () => void;
  onConnected: (id: string) => void;
}) {
  const t = useT();
  return <section class="fleet-connection" aria-label={t("fleet.connect.title")}>
    <h3>{t("fleet.connect.title")}</h3>
    <p class="note">{t("fleet.connect.note")}</p>
    <DevicePairingPanel targets={targets} allowed={!!account && canConfigure(account, "sys.pair.create")} ready={ready} onClose={onClose} onConnected={onConnected} />
  </section>;
}
