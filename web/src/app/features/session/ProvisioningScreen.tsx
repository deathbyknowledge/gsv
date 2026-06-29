import type { PendingAction } from "./sessionDomain";
import { provisioningCopy } from "./sessionDomain";
import { Progress } from "../../components/ui/Progress";
import { Spinner } from "../../components/ui/Spinner";
import { AuthLayout } from "./AuthLayout";
import "./ProvisioningScreen.css";

type ProvisioningScreenProps = {
  visible: boolean;
  pendingAction: PendingAction;
};

const STEPS = [
  { title: "Creating account", copy: "Securing your account and admin settings." },
  { title: "Preparing system files", copy: "Loading the built-in apps and starter settings." },
  { title: "Opening desktop", copy: "Getting the first session ready." },
];

export function ProvisioningScreen({
  visible,
  pendingAction,
}: ProvisioningScreenProps) {
  const copy = provisioningCopy(pendingAction);

  return (
    <AuthLayout background="galaxy" visible={visible} surfaceClass="gsv-auth-surface-setup">
      <div class="gsv-provision" data-session-provisioning-view>
        <div class="gsv-provision-head">
          <span class="gsv-provision-kicker">First-time setup · Setting up</span>
          <h2 class="gsv-provision-title" data-session-provisioning-title>{copy.title}</h2>
          <p class="gsv-provision-sub" data-session-provisioning-copy>{copy.copy}</p>
        </div>

        <Progress indeterminate label="" showValue={false} width={600} />

        <div class="gsv-provision-note">
          <strong>Keep this tab open</strong>
          <p>This can take a few seconds while GSV prepares your workspace.</p>
        </div>

        <ol class="gsv-provision-steps" aria-label="Setup progress">
          {STEPS.map((step) => (
            <li class="gsv-provision-step" key={step.title}>
              <span class="gsv-provision-step-marker" aria-hidden="true" />
              <div class="gsv-provision-step-text">
                <strong>{step.title}</strong>
                <p>{step.copy}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </AuthLayout>
  );
}
