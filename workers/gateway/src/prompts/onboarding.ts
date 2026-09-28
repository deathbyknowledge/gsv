import onboardingContext from "./onboarding/ship.md";

// Seeded into the personal agent's context.d/07-onboarding.md.
export const PERSONAL_INTELLIGENCE_ONBOARDING_CONTEXT = onboardingContext.trimEnd() + "\n";
