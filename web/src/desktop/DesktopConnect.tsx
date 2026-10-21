import { SpaceAddressForm } from "../app/features/session/SpaceAddressForm";
import { useT } from "../app/i18n/locale";

export function DesktopConnect(props: { ready: boolean; disabled?: boolean; onConnect(origin: string): Promise<void> }) {
  const t = useT();
  return <><SpaceAddressForm {...props} />
    {import.meta.env.DEV && <a class="gsv-auth-link" href="/?mock=1">{t("desktop.devMock")}</a>}
  </>;
}
