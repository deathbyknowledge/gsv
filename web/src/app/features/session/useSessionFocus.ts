import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import type { OnboardingDraft } from "@gsv/protocol/syscalls/system";
import type { SessionView } from "./sessionDomain";

export function useSessionFocus(
  screenRef: RefObject<HTMLElement>,
  visibleView: SessionView,
  draft: OnboardingDraft,
  continueButtonRef: RefObject<HTMLButtonElement>,
) {
  useEffect(() => {
    const root = screenRef.current;
    if (!root || visibleView === "desktop" || visibleView === "provisioning") {
      return;
    }

    if (visibleView === "login") {
      const username = root.querySelector<HTMLInputElement>("[data-session-username]");
      const password = root.querySelector<HTMLInputElement>("[data-session-password]");
      if (username && !username.value.trim()) {
        username.focus();
        return;
      }
      password?.focus();
      return;
    }

    if (visibleView === "complete") {
      continueButtonRef.current?.focus();
      return;
    }

    if (draft.stage === "welcome") {
      root.querySelector<HTMLElement>("[data-setup-lane]")?.focus();
      return;
    }
    if (draft.stage === "review") {
      root.querySelector<HTMLElement>("[data-setup-submit]")?.focus();
      return;
    }

    const activeSection = root.querySelector<HTMLElement>(".onboarding-section:not([hidden])");
    activeSection?.querySelector<HTMLElement>("input:not([disabled]):not([type='hidden']), select:not([disabled])")?.focus();
  }, [continueButtonRef, draft.detailStep, draft.stage, screenRef, visibleView]);
}
