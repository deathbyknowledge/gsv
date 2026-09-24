import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { DesktopConnect } from "./DesktopConnect";
import { loadDesktopWelcome } from "./welcome";

export function DesktopWelcome(props: {
  ready: boolean;
  resume: boolean;
  onConnect(origin: string, onboardingToken?: string | null): Promise<void>;
}) {
  return <OwnerWelcomeScreen {...props} load={loadDesktopWelcome}
    addressPanel={<DesktopConnect ready={props.ready} onConnect={props.onConnect} />} />;
}
