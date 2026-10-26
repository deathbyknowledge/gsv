import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import type { SessionMessage, SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { useT, type TextKey } from "../../i18n/locale";
import { validateSetupAccount, type SetupAccount } from "./sessionDomain";

type UseSessionScreensStateOptions = {
  session: SessionService;
  snapshot: SessionSnapshot;
};

const setupHistoryStateSchema = z.object({ gsvSetupConsent: z.boolean() });

export type SetupStep = "credentials" | "profile" | "consent";

export function useSessionScreensState({ session, snapshot }: UseSessionScreensStateOptions) {
  const t = useT();
  const [pendingAction, setPendingAction] = useState<"login" | "setup" | null>(null);
  const [loginValidationError, setLoginValidationError] = useState<TextKey | null>(null);
  const [setupTouched, setSetupTouched] = useState<Partial<Record<keyof SetupAccount, boolean>>>({});
  const [setupValidationAttempt, setSetupValidationAttempt] = useState(0);
  const [administrator, setAdministrator] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState("");
  const [setupConsent, setSetupConsent] = useState(false);
  const [setupConsentTouched, setSetupConsentTouched] = useState(false);
  const [setupProfile, setSetupProfile] = useState<"public" | "private" | null>(null);
  const [setupProfileTouched, setSetupProfileTouched] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>("credentials");
  const setupSubmitPressed = useRef(false);
  const setupHasConsentEntry = useRef(false);
  const setupHistoryLength = useRef(0);
  const setupErrors = validateSetupAccount({ password: setupPassword, passwordConfirm: setupPasswordConfirm });
  // Self-signup agreed to the terms before arriving; operator-created spaces still confirm them here.
  const setupConsentRequired = snapshot.setupConsentRequired !== false;
  // Before anything is published, the owner chooses whether their profile is public; no answer is preselected.
  const setupProfileChoice = snapshot.setupProfileChoice === true;
  // The steps after the password share one browser history entry; Back on the screen walks them.
  const setupLaterSteps: SetupStep[] = [...(setupProfileChoice ? ["profile" as const] : []), ...(setupConsentRequired ? ["consent" as const] : [])];
  const setupSecondStep = setupLaterSteps.length > 0;
  const setupSteps: SetupStep[] = ["credentials", ...setupLaterSteps];
  const screenRef = useRef<HTMLElement>(null);
  const busy = snapshot.phase === "authenticating";
  const visibleView = snapshot.phase === "ready" ? "ready"
    : snapshot.phase === "setup-recovery" ? "setup-recovery"
    : snapshot.phase === "setup" || (busy && pendingAction === "setup") ? "setup"
    : snapshot.phase === "booting" ? "booting" : "login";

  useEffect(() => {
    const releaseSubmit = () => { setupSubmitPressed.current = false; };
    window.addEventListener("pointerup", releaseSubmit, true);
    window.addEventListener("pointercancel", releaseSubmit, true);
    window.addEventListener("blur", releaseSubmit);
    return () => {
      window.removeEventListener("pointerup", releaseSubmit, true);
      window.removeEventListener("pointercancel", releaseSubmit, true);
      window.removeEventListener("blur", releaseSubmit);
    };
  }, []);

  useEffect(() => {
    if (visibleView !== "setup" || !setupSecondStep) return;
    setupHasConsentEntry.current = false;
    const setupUrl = new URL(window.location.href);
    const completedUrl = setupUrl.pathname === "/onboarding" ? new URL("/", setupUrl).href : setupUrl.href;
    let outsideUrl: string | null = null;
    window.history.replaceState({ gsvSetupConsent: false }, "");
    const onPopState = () => {
      const state = setupHistoryStateSchema.safeParse(window.history.state);
      outsideUrl = state.success ? null : window.location.href;
      setSetupStep(state.success && state.data.gsvSetupConsent ? setupLaterSteps[0] ?? "credentials" : "credentials");
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      const state = setupHistoryStateSchema.safeParse(window.history.state);
      if (!state.success) {
        // Back can leave both wizard entries ahead of an unrelated page.
        // Only traverse when that page was reached through history and the
        // forward entries have not been pruned by a new navigation.
        if (!setupHasConsentEntry.current || outsideUrl !== window.location.href
          || window.history.length !== setupHistoryLength.current) return;
        let traversed = 0;
        const repairForward = () => {
          traversed++;
          const next = setupHistoryStateSchema.safeParse(window.history.state);
          if (next.success) window.history.replaceState(null, "", completedUrl);
          if ((next.success && next.data.gsvSetupConsent) || traversed >= setupHistoryLength.current - 1) {
            window.removeEventListener("popstate", repairForward, true);
            window.history.go(-traversed);
          } else window.history.forward();
        };
        window.addEventListener("popstate", repairForward, true);
        window.history.forward();
        return;
      }
      const destination = window.location.href;
      window.history.replaceState(null, "");
      if (!setupHasConsentEntry.current) return;
      // Restore the completed URL before route listeners observe the original
      // wizard entry. Capability setup may already have replaced /onboarding.
      const restoreCredentials = () => {
        const previous = setupHistoryStateSchema.safeParse(window.history.state);
        if (previous.success && !previous.data.gsvSetupConsent) {
          window.history.replaceState(null, "", destination);
        }
      };
      const collapseConsent = () => {
        window.history.replaceState(null, "", destination);
        window.addEventListener("popstate", restoreCredentials, { once: true, capture: true });
        window.history.back();
      };
      if (state.data.gsvSetupConsent) collapseConsent();
      else {
        // Browser Back can leave consent ahead of us while setup is pending.
        // Rewrite that entry too, then return to the completed credentials slot.
        window.history.replaceState({ gsvSetupConsent: false }, "", destination);
        window.addEventListener("popstate", () => {
          const next = setupHistoryStateSchema.safeParse(window.history.state);
          if (next.success && next.data.gsvSetupConsent) collapseConsent();
        }, { once: true, capture: true });
        window.history.forward();
      }
    };
  }, [visibleView, setupSecondStep]);

  useLayoutEffect(() => {
    if (busy) return;
    const root = screenRef.current;
    if (!root || visibleView === "ready" || visibleView === "booting") return;
    if (visibleView === "setup" && setupStep !== "credentials") {
      root.querySelector<HTMLElement>("[data-setup-heading]")?.focus();
      return;
    }
    if (visibleView === "setup" && setupValidationAttempt > 0) {
      const invalid = root.querySelector<HTMLInputElement>('input[aria-invalid="true"]');
      if (invalid) { invalid.focus({ preventScroll: true }); return; }
    }
    const prefix = visibleView === "setup" ? "setup" : "session";
    const username = root.querySelector<HTMLInputElement>(`[data-${prefix}-username]`);
    if (username && !username.value) username.focus({ preventScroll: true });
    else root.querySelector<HTMLInputElement>(`[data-${prefix}-password]`)?.focus({ preventScroll: true });
  }, [busy, visibleView, setupStep, setupValidationAttempt]);

  useEffect(() => {
    if (snapshot.phase !== "authenticating") setPendingAction(null);
    if (snapshot.phase === "ready" || snapshot.phase === "locked") {
      setSetupPassword("");
      setSetupPasswordConfirm("");
      setSetupTouched({});
      setSetupConsent(false);
      setSetupConsentTouched(false);
      setSetupProfile(null);
      setSetupProfileTouched(false);
      setSetupStep("credentials");
    }
    if (snapshot.phase === "ready") setLoginPassword("");
  }, [snapshot.phase]);

  const submitLogin = (event: Event): void => {
    event.preventDefault();
    if (busy) return;
    if (!loginPassword) { setLoginValidationError("session.login.passwordRequired"); return; }
    setLoginValidationError(null);
    setPendingAction("login");
    void session.login({ username: administrator ? "root" : undefined, password: loginPassword }).catch(() => {
      // Error is reflected through session snapshot.
    });
  };

  const submitSetup = (event: Event): void => {
    event.preventDefault();
    setupSubmitPressed.current = false;
    if (busy) return;
    const account = { password: setupPassword };
    setSetupTouched({ password: true, passwordConfirm: true });
    if (Object.keys(setupErrors).length > 0) {
      if (setupStep !== "credentials") window.history.back();
      setSetupStep("credentials");
      setSetupValidationAttempt((attempt) => attempt + 1);
      return;
    }
    if (setupStep === "credentials" && setupSecondStep) {
      window.history.pushState({ gsvSetupConsent: true }, "");
      setupHasConsentEntry.current = true;
      setupHistoryLength.current = window.history.length;
      setSetupStep(setupLaterSteps[0]!);
      return;
    }
    if (setupStep === "profile") {
      setSetupProfileTouched(true);
      if (!setupProfile) return;
    }
    if (setupStep === "consent") {
      setSetupConsentTouched(true);
      if (!setupConsent) return;
    }
    const next = setupSteps[setupSteps.indexOf(setupStep) + 1];
    if (next) { setSetupStep(next); return; }
    setLoginValidationError(null);
    setPendingAction("setup");
    void session.setup({ ...account, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      language: navigator.languages?.[0] || navigator.language || undefined,
      ...(setupProfileChoice && setupProfile ? { profile: setupProfile } : undefined) }).catch(() => {
      // Error is reflected through session snapshot.
    });
  };

  // The session's own notices are translated; Kernel and storage errors are shown as sent.
  const messageText = (message: SessionMessage | null) => message && ("key" in message ? t(message.key) : message.text);
  return {
    screenRef,
    visibleView,
    busy,
    login: {
      error: loginValidationError ? t(loginValidationError) : messageText(snapshot.phase === "locked" ? snapshot.message : null),
      administrator,
      password: loginPassword,
      onAdministrator: (value: boolean) => { setAdministrator(value); setLoginPassword(""); setLoginValidationError(null); },
      onPassword: (value: string) => { setLoginValidationError(null); setLoginPassword(value); },
      onSubmit: submitLogin,
    },
    setup: {
      step: setupStep,
      consentRequired: setupConsentRequired,
      secondStep: setupSecondStep,
      lastStep: setupStep === setupSteps[setupSteps.length - 1],
      profileChoice: setupProfileChoice,
      profile: setupProfile,
      profileError: setupProfileTouched && !setupProfile ? t("session.setup.profile.required") : null,
      onProfile: (choice: "public" | "private") => { setSetupProfile(choice); setSetupProfileTouched(true); },
      error: messageText(snapshot.phase === "setup" ? snapshot.message : null),
      // An untouched field stays quiet until something is typed in it or a submit is attempted.
      fieldErrors: {
        password: setupTouched.password && (setupPassword || setupValidationAttempt > 0) && setupErrors.password ? t(setupErrors.password) : undefined,
        passwordConfirm: setupTouched.passwordConfirm && (setupPasswordConfirm || setupValidationAttempt > 0) && setupErrors.passwordConfirm ? t(setupErrors.passwordConfirm) : undefined,
      },
      password: setupPassword,
      passwordConfirm: setupPasswordConfirm,
      consent: setupConsent,
      consentError: setupConsentTouched && !setupConsent ? t("session.consent.required") : null,
      onPassword: setSetupPassword,
      onPasswordConfirm: setSetupPasswordConfirm,
      onConsent: (checked: boolean) => { setSetupConsent(checked); setSetupConsentTouched(true); },
      onBack: () => {
        if (busy) return;
        const previous = setupSteps[setupSteps.indexOf(setupStep) - 1] ?? "credentials";
        if (previous === "credentials") window.history.back();
        setSetupStep(previous);
      },
      onFieldBlur: (field: keyof SetupAccount, next: EventTarget | null) => {
        // Submission validates every field. Showing an error on pointer-down
        // would move Continue before pointer-up and swallow the click.
        if (setupSubmitPressed.current || (next && next === screenRef.current?.querySelector("[data-setup-submit]"))) return;
        setSetupTouched((touched) => ({ ...touched, [field]: true }));
      },
      onSubmitPointerDown: () => { setupSubmitPressed.current = true; },
      onSubmit: submitSetup,
    },
  };
}
