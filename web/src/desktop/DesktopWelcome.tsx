import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { publicDeployment } from "../app/services/deployment";
import { DesktopConnect } from "./DesktopConnect";
import { accountsOrigin, loadDesktopWelcome } from "./welcome";

export function DesktopWelcome(props: {
  ready: boolean;
  resume: boolean;
  onConnect(origin: string, onboardingToken?: string | null): Promise<void>;
}) {
  if (!accountsOrigin) return <DesktopConnect ready={props.ready} disabled={!props.ready} onConnect={props.onConnect} />;
  return <OwnerWelcomeScreen {...props} load={loadDesktopWelcome} spaceDomain={publicDeployment().primaryDomain}
    addressPanel={({ connect, disabled }) => <DesktopConnect ready={props.ready} disabled={disabled} onConnect={connect} />} />;
}
