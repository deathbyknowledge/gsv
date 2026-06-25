import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import type { SessionView } from "./sessionDomain";

export function useSessionFocus(
  screenRef: RefObject<HTMLElement>,
  visibleView: SessionView,
  draft: OnboardingDraft,
  continueButtonRef: RefObject<HTMLButtonElement>,
) {
  useEffect(() => {
    const root = screenRef.current;
    if (!root || visibleView === "booting" || visibleView === "desktop" || visibleView === "provisioning") {
      return;
    }

    if (visibleView === "login") {
      const username = root.querySelector<HTMLInputElement>("[data-session-username]");
      const password = root.querySelector<HTMLInputElement>("[data-session-password]");
      if (username && !username.value.trim()) {
        username.focus({ preventScroll: true });
        return;
      }
      password?.focus({ preventScroll: true });
      return;
    }

    if (visibleView === "complete") {
      continueButtonRef.current?.focus({ preventScroll: true });
      return;
    }

    if (draft.stage === "welcome") {
      root.querySelector<HTMLElement>("[data-setup-lane]")?.focus({ preventScroll: true });
      return;
    }
    if (draft.stage === "review") {
      root.querySelector<HTMLElement>("[data-setup-submit]")?.focus({ preventScroll: true });
      return;
    }

    const activeSection = root.querySelector<HTMLElement>(".onboarding-section:not([hidden])");
    activeSection?.querySelector<HTMLElement>("input:not([disabled]):not([type='hidden']), select:not([disabled])")?.focus({ preventScroll: true });
  }, [continueButtonRef, draft.detailStep, draft.stage, screenRef, visibleView]);
}
