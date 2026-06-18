import type { PendingAction } from "./sessionDomain";
import { provisioningCopy } from "./sessionDomain";
import { DeployStageRail } from "./SessionChrome";

type ProvisioningScreenProps = {
  visible: boolean;
  pendingAction: PendingAction;
};

export function ProvisioningScreen({
  visible,
  pendingAction,
}: ProvisioningScreenProps) {
  const copy = provisioningCopy(pendingAction);

  return (
    <div class="session-panel session-panel-wide onboarding-panel onboarding-status-panel onboarding-deploying-panel" data-session-provisioning-view hidden={!visible}>
      <div class="session-setup-form onboarding-layout">
        <aside class="onboarding-sidebar">
          <div class="session-panel-head">
            <p class="session-kicker">First-time setup</p>
            <h1>Setting things up</h1>
            <p class="session-copy">The desktop is almost ready.</p>
          </div>
          <DeployStageRail />
        </aside>
        <div class="onboarding-workspace">
          <main class="onboarding-main onboarding-status-main">
            <section class="onboarding-stage onboarding-status-stage">
              <div class="onboarding-lane-banner">
                <span>Setting things up</span>
              </div>
              <div class="setup-step-copy">
                <h2 data-session-provisioning-title>{copy.title}</h2>
                <p class="session-copy" data-session-provisioning-copy>{copy.copy}</p>
              </div>
              <div class="onboarding-deploy-status">
                <div class="onboarding-deploy-spinner" aria-hidden="true" />
                <div>
                  <strong>Keep this tab open</strong>
                  <p>This can take a few seconds while GSV prepares your workspace.</p>
                </div>
              </div>
              <ol class="onboarding-deploy-steps" aria-label="Setup progress">
                <li>
                  <span />
                  <div>
                    <strong>Creating account</strong>
                    <p>Securing your account and admin settings.</p>
                  </div>
                </li>
                <li>
                  <span />
                  <div>
                    <strong>Preparing system files</strong>
                    <p>Loading the built-in apps and starter settings.</p>
                  </div>
                </li>
                <li>
                  <span />
                  <div>
                    <strong>Opening desktop</strong>
                    <p>Getting the first session ready.</p>
                  </div>
                </li>
              </ol>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
