import { SpaceAddressForm } from "../app/features/session/SpaceAddressForm";

export function DesktopConnect(props: { ready: boolean; disabled?: boolean; onConnect(origin: string): Promise<void> }) {
  return <><SpaceAddressForm {...props} />
    {import.meta.env.DEV && <a class="gsv-auth-link" href="/?mock=1">open the development mock</a>}
  </>;
}
