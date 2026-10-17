import { PolicySummaryLink } from "./PolicySummaryLink";
import { publicDeployment } from "../../services/deployment";

export function TermsOfServiceLink() {
  const deployment = publicDeployment();
  if (!deployment.termsUrl) return null;
  return <PolicySummaryLink title="Terms of Service" href={deployment.termsUrl}
    introduction={`Your agreement with ${deployment.operatorName ?? "your operator"}.`}
    points={[
      "Read your operator's terms before creating an account or space.",
      "Check the conditions that apply to your use of the service.",
    ]} />;
}

export function PolicyConsentLabel({ id }: { id: string }) {
  const deployment = publicDeployment();
  return <span id={`${id}-label`}>
    <label for={id}>I confirm that I’m 18 or older</label>
    {deployment.termsUrl && <><label for={id}> and agree to the </label><TermsOfServiceLink /></>}
    {deployment.privacyUrl && <><label for={id}> and acknowledge the </label><PrivacyPolicyLink /></>}.
  </span>;
}

export function PrivacyPolicyLink() {
  const deployment = publicDeployment();
  if (!deployment.privacyUrl) return null;
  return <PolicySummaryLink title="Privacy Policy" href={deployment.privacyUrl}
    introduction={`How ${deployment.operatorName ?? "your operator"} handles your data.`}
    points={[
      "Review how your account information, conversations, files, and connected services are handled.",
      "Check your operator's policies on sharing, retention, access, corrections, and deletion.",
    ]} />;
}
