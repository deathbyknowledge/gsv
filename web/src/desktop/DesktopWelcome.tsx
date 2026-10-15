import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { DesktopConnect } from "./DesktopConnect";
import { accountsOrigin, loadDesktopWelcome } from "./welcome";

export function DesktopWelcome(props: {
  ready: boolean;
  resume: boolean;
  onConnect(origin: string, onboardingToken?: string | null): Promise<void>;
}) {
  if (!accountsOrigin) return <DesktopConnect ready={props.ready} disabled={!props.ready} onConnect={props.onConnect} />;
  return <OwnerWelcomeScreen {...props} load={loadDesktopWelcome}
    addressPanel={({ connect, disabled }) => <DesktopConnect ready={props.ready} disabled={disabled} onConnect={connect} />} />;
}
