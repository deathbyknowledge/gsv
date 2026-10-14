import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { validateSetupAccount, type SetupAccount } from "./sessionDomain";

type UseSessionScreensStateOptions = {
  session: SessionService;
  snapshot: SessionSnapshot;
};

const setupHistoryStateSchema = z.object({ gsvSetupConsent: z.boolean() });

export function useSessionScreensState({ session, snapshot }: UseSessionScreensStateOptions) {
  const [pendingAction, setPendingAction] = useState<"login" | "setup" | null>(null);
  const [loginValidationError, setLoginValidationError] = useState<string | null>(null);
  const [setupTouched, setSetupTouched] = useState<Partial<Record<keyof SetupAccount, boolean>>>({});
  const [setupValidationAttempt, setSetupValidationAttempt] = useState(0);
  const [administrator, setAdministrator] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState("");
  const [setupConsent, setSetupConsent] = useState(false);
  const [setupConsentTouched, setSetupConsentTouched] = useState(false);
  const [setupStep, setSetupStep] = useState<"credentials" | "consent">("credentials");
  const setupSubmitPressed = useRef(false);
  const setupHasConsentEntry = useRef(false);
  const setupHistoryLength = useRef(0);
  const setupErrors = validateSetupAccount({ password: setupPassword, passwordConfirm: setupPasswordConfirm });
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
    if (visibleView !== "setup") return;
    setupHasConsentEntry.current = false;
    const setupUrl = new URL(window.location.href);
    const completedUrl = setupUrl.pathname === "/onboarding" ? new URL("/", setupUrl).href : setupUrl.href;
    let outsideUrl: string | null = null;
    window.history.replaceState({ gsvSetupConsent: false }, "");
    const onPopState = () => {
      const state = setupHistoryStateSchema.safeParse(window.history.state);
      outsideUrl = state.success ? null : window.location.href;
      setSetupStep(state.success && state.data.gsvSetupConsent ? "consent" : "credentials");
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
  }, [visibleView]);


  useLayoutEffect(() => {
    if (busy) return;
    const root = screenRef.current;
    if (!root || visibleView === "ready" || visibleView === "booting") return;
    if (visibleView === "setup" && setupStep === "consent") {
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
      setSetupStep("credentials");
    }
    if (snapshot.phase === "ready") setLoginPassword("");
  }, [snapshot.phase]);

  const submitLogin = (event: Event): void => {
    event.preventDefault();
    if (busy) return;
    if (!loginPassword) { setLoginValidationError("Password is required."); return; }
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
      if (setupStep === "consent") window.history.back();
      setSetupStep("credentials");
      setSetupValidationAttempt((attempt) => attempt + 1);
      return;
    }
    if (setupStep === "credentials") {
      window.history.pushState({ gsvSetupConsent: true }, "");
      setupHasConsentEntry.current = true;
      setupHistoryLength.current = window.history.length;
      setSetupStep("consent");
      return;
    }
    setSetupConsentTouched(true);
    if (!setupConsent) return;
    setLoginValidationError(null);
    setPendingAction("setup");
    void session.setup({ ...account, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }).catch(() => {
      // Error is reflected through session snapshot.
    });
  };

  return {
    screenRef,
    visibleView,
    busy,
    login: {
      error: loginValidationError ?? (snapshot.phase === "locked" ? snapshot.message : null),
      administrator,
      password: loginPassword,
      onAdministrator: (value: boolean) => { setAdministrator(value); setLoginPassword(""); setLoginValidationError(null); },
      onPassword: (value: string) => { setLoginValidationError(null); setLoginPassword(value); },
      onSubmit: submitLogin,
    },
    setup: {
      step: setupStep,
      error: snapshot.phase === "setup" ? snapshot.message : null,
      fieldErrors: {
        password: setupTouched.password ? setupErrors.password : undefined,
        passwordConfirm: setupTouched.passwordConfirm ? setupErrors.passwordConfirm : undefined,
      },
      password: setupPassword,
      passwordConfirm: setupPasswordConfirm,
      consent: setupConsent,
      consentError: setupConsentTouched && !setupConsent ? "Confirm your age and agreement to continue." : null,
      onPassword: setSetupPassword,
      onPasswordConfirm: setSetupPasswordConfirm,
      onConsent: (checked: boolean) => { setSetupConsent(checked); setSetupConsentTouched(true); },
      onBack: () => {
        if (busy) return;
        window.history.back();
        setSetupStep("credentials");
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
