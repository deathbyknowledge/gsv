import { PolicySummaryLink } from "./PolicySummaryLink";

export function TermsOfServiceLink() {
  return <PolicySummaryLink title="Terms of Service" href="https://gsv.space/terms"
    introduction="Your agreement with Humans & Machines, Inc."
    points={[
      "Covers your account and the spaces you create, own, or manage, including acceptable use and your responsibilities as an account owner.",
      "Explains third-party services, ownership, account termination, disclaimers, and limits on liability.",
    ]} />;
}

export function PrivacyPolicyLink() {
  return <PolicySummaryLink title="Privacy Policy" href="https://gsv.space/privacy"
    introduction="How Humans & Machines, Inc. handles your data."
    points={[
      "We do not sell or rent your personal information. We do not use your private conversations, files, or connected-account content to train general-purpose AI models.",
      "Explains when data is shared with service providers, how long it is kept, and how to request access, corrections, or deletion at hello@humansandmachin.es.",
    ]} />;
}
