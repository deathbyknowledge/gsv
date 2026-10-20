import { PolicySummaryLink } from "./PolicySummaryLink";
import { publicDeployment } from "../../services/deployment";
import { useT } from "../../i18n/locale";

export function TermsOfServiceLink() {
  const t = useT();
  const deployment = publicDeployment();
  if (!deployment.termsUrl) return null;
  return <PolicySummaryLink title={t("session.policy.terms")} href={deployment.termsUrl} readLabel={t("session.policy.termsFull")}
    introduction={deployment.operatorName ? t("session.policy.termsAgreement", { operator: deployment.operatorName }) : t("session.policy.termsAgreementDefault")}
    points={[
      t("session.policy.termsRead"),
      t("session.policy.termsConditions"),
    ]} />;
}

export function PolicyConsentLabel({ id }: { id: string }) {
  const t = useT();
  const deployment = publicDeployment();
  const sentence = deployment.termsUrl
    ? t(deployment.privacyUrl ? "session.consent.ageTermsPrivacy" : "session.consent.ageTerms")
    : t(deployment.privacyUrl ? "session.consent.agePrivacy" : "session.consent.age");
  // The policy links open their summaries; the rest of the sentence labels the checkbox.
  return <span id={`${id}-label`}>
    {sentence.split(/(\{terms\}|\{privacy\})/).map((part) => part === "{terms}" ? <TermsOfServiceLink />
      : part === "{privacy}" ? <PrivacyPolicyLink /> : part && <label for={id}>{part}</label>)}
  </span>;
}

export function PrivacyPolicyLink() {
  const t = useT();
  const deployment = publicDeployment();
  if (!deployment.privacyUrl) return null;
  return <PolicySummaryLink title={t("session.policy.privacy")} href={deployment.privacyUrl} readLabel={t("session.policy.privacyFull")}
    introduction={deployment.operatorName ? t("session.policy.privacyHandling", { operator: deployment.operatorName }) : t("session.policy.privacyHandlingDefault")}
    points={[
      t("session.policy.privacyReview"),
      t("session.policy.privacyPolicies"),
    ]} />;
}
