import { useEffect, useRef, useState } from "preact/hooks";
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
  const [loginUsername, setLoginUsername] = useState(snapshot.username);
  const [loginUsernameTouched, setLoginUsernameTouched] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [setupUsername, setSetupUsername] = useState(snapshot.username);
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState("");
  const [setupConsent, setSetupConsent] = useState(false);
  const [setupConsentTouched, setSetupConsentTouched] = useState(false);
  const [setupStep, setSetupStep] = useState<"credentials" | "consent">("credentials");
  const setupErrors = validateSetupAccount({ username: setupUsername, password: setupPassword, passwordConfirm: setupPasswordConfirm });
  const screenRef = useRef<HTMLElement>(null);
  const busy = snapshot.phase === "authenticating";
  const visibleView = snapshot.phase === "ready" ? "ready"
    : snapshot.phase === "setup" || (busy && pendingAction === "setup") ? "setup"
    : snapshot.phase === "booting" ? "booting" : "login";

  useEffect(() => {
    if (visibleView !== "setup") return;
    window.history.replaceState({ gsvSetupConsent: false }, "");
    const onPopState = () => {
      const state = setupHistoryStateSchema.safeParse(window.history.state);
      setSetupStep(state.success && state.data.gsvSetupConsent ? "consent" : "credentials");
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      const state = setupHistoryStateSchema.safeParse(window.history.state);
      if (!state.success) return;
      const destination = window.location.href;
      window.history.replaceState(null, "");
      if (!state.data.gsvSetupConsent) return;
      // Restore the completed URL before route listeners observe the original
      // wizard entry. Capability setup may already have replaced /onboarding.
      window.addEventListener("popstate", () => {
        const previous = setupHistoryStateSchema.safeParse(window.history.state);
        if (previous.success && !previous.data.gsvSetupConsent) {
          window.history.replaceState(null, "", destination);
        }
      }, { once: true, capture: true });
      window.history.back();
    };
  }, [visibleView]);

  // Sync login username from snapshot (e.g. after first-boot setup creates the
  // account) but only if the user hasn't manually edited or cleared the field.
  useEffect(() => {
    if (!loginUsernameTouched && snapshot.username) setLoginUsername(snapshot.username);
  }, [snapshot.username, loginUsernameTouched]);

  useEffect(() => {
    if (busy) return;
    const root = screenRef.current;
    if (!root || visibleView === "ready" || visibleView === "booting") return;
    if (visibleView === "setup" && setupStep === "consent") {
      root.querySelector<HTMLElement>("[data-setup-heading]")?.focus();
      return;
    }
    const prefix = visibleView === "setup" ? "setup" : "session";
    const username = root.querySelector<HTMLInputElement>(`[data-${prefix}-username]`);
    if (username && !username.value) username.focus({ preventScroll: true });
    else root.querySelector<HTMLInputElement>(`[data-${prefix}-password]`)?.focus({ preventScroll: true });
  }, [busy, visibleView, setupStep]);

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
    const username = loginUsername.trim();
    if (!username) { setLoginValidationError("Username is required."); return; }
    if (!loginPassword) { setLoginValidationError("Password is required."); return; }
    setLoginValidationError(null);
    setPendingAction("login");
    void session.login({ username, password: loginPassword }).catch(() => {
      // Error is reflected through session snapshot.
    });
  };

  const submitSetup = (event: Event): void => {
    event.preventDefault();
    if (busy) return;
    const account = { username: setupUsername, password: setupPassword };
    setSetupTouched({ username: true, password: true, passwordConfirm: true });
    if (Object.keys(setupErrors).length > 0) {
      setSetupStep("credentials");
      return;
    }
    if (setupStep === "credentials") {
      window.history.pushState({ gsvSetupConsent: true }, "");
      setSetupStep("consent");
      return;
    }
    setSetupConsentTouched(true);
    if (!setupConsent) return;
    setLoginValidationError(null);
    setLoginUsername(account.username);
    setLoginUsernameTouched(false);
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
      username: loginUsername,
      password: loginPassword,
      onUsername: (value: string) => { setLoginValidationError(null); setLoginUsername(value); setLoginUsernameTouched(true); },
      onPassword: (value: string) => { setLoginValidationError(null); setLoginPassword(value); },
      onSubmit: submitLogin,
    },
    setup: {
      step: setupStep,
      error: snapshot.phase === "setup" ? snapshot.message : null,
      fieldErrors: {
        username: setupTouched.username ? setupErrors.username : undefined,
        password: setupTouched.password ? setupErrors.password : undefined,
        passwordConfirm: setupTouched.passwordConfirm ? setupErrors.passwordConfirm : undefined,
      },
      username: setupUsername,
      password: setupPassword,
      passwordConfirm: setupPasswordConfirm,
      consent: setupConsent,
      consentError: setupConsentTouched && !setupConsent ? "Confirm your age and agreement to continue." : null,
      onUsername: (value: string) => { setSetupUsername(value.toLowerCase()); },
      onPassword: setSetupPassword,
      onPasswordConfirm: setSetupPasswordConfirm,
      onConsent: (checked: boolean) => { setSetupConsent(checked); setSetupConsentTouched(true); },
      onBack: () => {
        if (busy) return;
        window.history.back();
        setSetupStep("credentials");
      },
      onFieldBlur: (field: keyof SetupAccount) => { setSetupTouched((touched) => ({ ...touched, [field]: true })); },
      onSubmit: submitSetup,
    },
  };
}
