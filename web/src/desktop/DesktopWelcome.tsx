import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { OwnerWelcome } from "../app/services/session/ownerWelcome";
import { DesktopConnect } from "./DesktopConnect";
import { invoke } from "./bridge";

const accountsOrigin = import.meta.env.VITE_GSV_ACCOUNTS_ORIGIN || "https://gsv.space";

async function load() {
  const snapshot = await invoke("desktop_welcome");
  return new OwnerWelcome(snapshot, {
    save: (revision, value) => invoke("desktop_save_welcome", { revision, value }),
  }, accountsOrigin);
}

export function DesktopWelcome(props: {
  ready: boolean;
  resume: boolean;
  onConnect(origin: string, onboardingToken?: string | null): Promise<void>;
}) {
  return <OwnerWelcomeScreen {...props} accountsOrigin={accountsOrigin} load={load}
    addressPanel={<DesktopConnect ready={props.ready} onConnect={props.onConnect} />} />;
}
