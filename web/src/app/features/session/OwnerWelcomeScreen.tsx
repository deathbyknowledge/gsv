import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { AuthLayout } from "./AuthLayout";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/TextInput";
import { Spinner } from "../../components/ui/Spinner";
import { WelcomeIllustration } from "./backgrounds/WelcomeIllustration";
import { PrivacyPolicyLink, TermsOfServiceLink } from "./PolicyLinks";
import { OwnerWelcome, OwnerApiError, type OwnerSession, type PendingSetup, type WelcomeState } from "../../services/session/ownerWelcome";
import "./LoginScreen.css";
import "./OwnerWelcomeScreen.css";

type Step = "welcome" | "invitation" | "email" | "code" | "spaces" | "consent" | "handle";
type Props = {
  ready: boolean;
  resume: boolean;
  load(): Promise<OwnerWelcome>;
  onConnect(origin: string, onboardingToken?: string | null): Promise<void>;
  addressPanel?: (options: { disabled: boolean; connect(origin: string): Promise<void> }) => ComponentChildren;
  initialStep?: "welcome" | "email";
  chooseSpace?: boolean;
  invitation?: { name?: string; origin?: string };
  compact?: boolean;
};

export function OwnerWelcomeScreen({ ready, resume, load, onConnect, addressPanel, initialStep = "welcome", chooseSpace = false, invitation, compact = false }: Props) {
  const [flow, setFlow] = useState<OwnerWelcome | null>(null);
  const [step, setStep] = useState<Step>(invitation ? "invitation" : initialStep);
  const [owner, setOwner] = useState<OwnerSession | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [consentTouched, setConsentTouched] = useState(false);
  const consentId = useId();
  const [code, setCode] = useState("");
  const [handle, setHandle] = useState("");
  const [handleError, setHandleError] = useState("");
  const [availability, setAvailability] = useState<"idle" | "checking" | "available" | "unavailable">("idle");

  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not continue. Try again.");
      if (failure instanceof OwnerApiError && failure.code === "space_exists" && flow) await advance(flow);
      if (failure instanceof OwnerApiError && failure.code === "signed_out") { setOwner(null); setStep("email"); }
    } finally { pending.current = false; setBusy(false); }
  };
  const openSetup = async (client: OwnerWelcome, setup: PendingSetup) => {
    await client.save({ flow: "create", operationId: setup.operationId, handle: setup.handle });
    if (!consent) { setStep("consent"); return; }
    const prepared = await client.prepare(setup.handle, setup.operationId);
    await onConnect(prepared.origin, prepared.onboardingToken);
  };
  const advance = async (client: OwnerWelcome) => {
    const session = await client.session();
    setOwner(session);
    if (!session) { setStep(client.state.challenge ? "code" : "email"); return; }
    if (client.state.challenge) await client.save({ challenge: null });
    const pendingSetup = session.setups.find((setup) => setup.operationId === client.state.operationId);
    if (pendingSetup) { await openSetup(client, pendingSetup); return; }
    if (session.spaces.length || session.setups.length || client.state.flow === "open" || !session.signupEnabled) {
      setStep("spaces"); return;
    }
    // Signing in or restoring a session does not imply agreement to create a space.
    if (!consent) { setStep("consent"); return; }
    setHandle(client.state.handle ?? ""); setStep("handle");
  };

  useEffect(() => {
    if (!ready) return;
    let mounted = true;
    void run(async () => {
      let client: OwnerWelcome;
      try { client = await load(); }
      catch {
        if (mounted) setLoadError("Could not load sign-in. Try again.");
        return;
      }
      if (!mounted) return;
      setFlow(client);
      setEmail(client.state.challenge?.email ?? "");
      if (!invitation && (resume || client.state.challenge || client.state.operationId)) await advance(client);
    });
    return () => { mounted = false; };
  }, [ready]);

  useEffect(() => {
    setHandleError("");
    if (!flow || step !== "handle" || !handle.trim()) { setAvailability("idle"); return; }
    let active = true;
    setAvailability("checking");
    const timer = setTimeout(() => {
      void flow.available(handle.trim()).then((available) => { if (active) setAvailability(available ? "available" : "unavailable"); })
        .catch((failure) => {
          if (!active) return;
          setAvailability("idle");
          setHandleError(failure instanceof Error ? failure.message : "Could not check this handle. Try again.");
        });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [step, handle, flow]);

  const titles = {
    welcome: "Welcome to GSV", invitation: invitation?.name ? `${invitation.name} invited you to GSV` : "You’re invited to GSV", email: "Your email", code: "Check your email", spaces: "Your spaces", consent: "Before you begin", handle: "Choose your handle",
  } satisfies Record<Step, string>;
  const requiresConsent = step === "consent" || (step === "email" && flow?.state.flow === "create");
  const consentError = requiresConsent && consentTouched && !consent;
  const formError = error === handleError ? loadError : error || loadError;
  const start = (intent: "open" | "create") => void run(async () => {
    setConsent(false); setConsentTouched(false);
    if (intent === "open") setStep("email");
    if (!flow) return;
    const change: Partial<WelcomeState> = { flow: intent, operationId: null, handle: null };
    await flow.save(change);
    await advance(flow);
  });
  const submit = (event: Event) => {
    event.preventDefault();
    if (requiresConsent && !consent) { setConsentTouched(true); return; }
    void run(async () => {
      if (!flow) return;
      if (step === "invitation") {
        await flow.save({ flow: "create" });
        await advance(flow);
      } else if (step === "email") {
        await flow.sendCode(email.trim().toLowerCase()); setStep("code");
      } else if (step === "code") {
        await flow.verify(code); setCode(""); await advance(flow);
      } else if (step === "consent") {
        await advance(flow);
      } else if (step === "handle") {
        if (!consent) { setStep("consent"); return; }
        const prepared = await flow.prepare(handle.trim());
        await onConnect(prepared.origin, prepared.onboardingToken);
      }
    });
  };
  const actionDisabled = !flow || busy || (step === "email" ? !email.trim()
    : step === "code" ? code.length !== 6 : step === "handle" ? !handle.trim() || availability === "unavailable" : false);
  const opening = step === "spaces" || (step === "email" && (chooseSpace || flow?.state.flow !== "create"));
  const title = invitation && step === "email" ? "Join GSV"
    : !opening ? titles[step] : !compact ? "Open your space" : step === "spaces" ? "Choose your space" : "Sign in";
  const split = opening && !!addressPanel && !compact;
  const address = () => addressPanel?.({ disabled: busy, connect: (origin) => run(async () => {
    try { await onConnect(origin); }
    catch { throw new Error("Could not open this space. Try again."); }
  }) });
  const back = () => {
    setError("");
    if (invitation && step !== "code") { setStep("invitation"); return; }
    setStep(step === "code" ? "email" : "welcome");
  };

  return <AuthLayout visible surfaceClass="gsv-auth-surface-login"><section class={`desktop-welcome${step === "welcome" || split ? " desktop-welcome-wide" : ""}`}>
    <h1>{title}</h1>
    {step === "welcome" ? <div class="desktop-welcome-columns desktop-welcome-choices">
      <button class="desktop-welcome-choice" type="button" aria-label="Create your space" disabled={!flow || busy} onClick={() => start("create")}>
        <WelcomeIllustration kind="create" />
        <span class="desktop-welcome-choice-title">Create your space <span aria-hidden="true">→</span></span>
      </button>
      <div class="desktop-welcome-choice desktop-welcome-choice-interactive">
        <WelcomeIllustration kind="open" />
        <button class="desktop-welcome-choice-title" type="button" aria-label="Open your space" disabled={!ready || busy} onClick={() => start("open")}>
          Open your space <span aria-hidden="true">→</span>
        </button>
      </div>
    </div> : <div class={split ? "desktop-welcome-columns" : "desktop-welcome-form"}>
      <div class="desktop-welcome-primary">
      {opening && !compact && <h2>{step === "spaces" ? "Your spaces" : "Sign in with email"}</h2>}
      <form key={step} class="gsv-login-fields" onSubmit={submit} aria-busy={busy}>
        {step === "invitation" && <div class="desktop-welcome-invitation">
          {invitation?.origin && <p class="desktop-welcome-detail">{invitation.origin}</p>}
          <p>Join GSV or open your space to connect.</p>
        </div>}
        {step === "email" && <TextInput label="Email" value={email} onChange={setEmail} disabled={busy} placeholder="you@example.com"
          inputProps={{ autoFocus: true, type: "email", autoComplete: "email", maxLength: 254, required: true }} />}
        {requiresConsent && <div class={`gsv-owner-consent${consentError ? " is-error" : ""}`}>
          <div class="gsv-owner-consent-row">
            <input id={consentId} type="checkbox" required checked={consent} disabled={busy} autoFocus={step === "consent"}
              aria-labelledby={`${consentId}-label`} aria-invalid={consentError ? true : undefined}
              aria-describedby={consentError ? `${consentId}-error` : undefined}
              onInvalid={() => setConsentTouched(true)}
              onChange={(event) => { setConsent(event.currentTarget.checked); setConsentTouched(true); }} />
            <span id={`${consentId}-label`}><label for={consentId}>I confirm that I’m 18 or older and agree to the </label>
              <TermsOfServiceLink /> <label for={consentId}>and acknowledge the </label><PrivacyPolicyLink />.</span>
          </div>
          {consentError && <p class="gsv-owner-consent-error" id={`${consentId}-error`} role="alert">Confirm your age and agreement to continue.</p>}
        </div>}
        {step === "code" && <>
          <p class="desktop-welcome-detail">{flow?.state.challenge?.email}</p>
          <TextInput label="Code" value={code} onChange={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))} disabled={busy}
            placeholder="000000" inputProps={{ autoFocus: true, inputMode: "numeric", autoComplete: "one-time-code", maxLength: 6 }} />
        </>}
        {step === "handle" && <TextInput label="Handle" value={handle} onChange={(value) => { setHandle(value.toLowerCase()); setError(""); }} disabled={busy} suffix={owner ? `.${owner.spaceDomain}` : undefined}
          placeholder="your-name" status={handleError || availability === "unavailable" ? "error" : availability === "available" ? "success" : "none"}
          message={handleError || (availability === "available" ? "Available" : availability === "unavailable" ? "Already taken" : "")}
          inputProps={{ autoFocus: true, autoCapitalize: "none", spellcheck: false, maxLength: 63 }} />}
        {step === "spaces" && <>
          <p class="desktop-welcome-detail">{owner?.email}</p>
          {owner?.spaces.map((space) => <Button key={space.canonicalOrigin} label={space.handle} variant="secondary" block disabled={busy}
            onClick={() => void run(() => onConnect(space.canonicalOrigin))} />)}
          {owner?.setups.map((setup) => <Button key={setup.operationId}
            label={`Continue ${setup.handle}`} variant="secondary" block disabled={busy}
            onClick={() => void run(() => openSetup(flow!, setup))} />)}
          {!owner?.spaces.length && !owner?.setups.length && <>
            {owner?.signupEnabled ? <Button label="Create your space" disabled={busy} block onClick={() => start("create")} />
              : <p class="desktop-welcome-detail">Registration is currently closed.</p>}
          </>}
        </>}
        {step !== "spaces" && <button class="gsv-btn gsv-btn-primary gsv-btn-block desktop-welcome-submit" type="submit" aria-label={step === "email" ? "Send code" : "Continue"} disabled={actionDisabled} autoFocus={step === "invitation"}>
          {busy ? <Spinner /> : <span class="gsv-btn-label">{step === "email" ? "Send code" : "Continue"}</span>}
        </button>}
        {step === "code" && <div class="desktop-welcome-links">
          <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => void run(async () => {
            try { await flow!.sendCode(flow!.state.challenge!.email, true); }
            catch (failure) {
              if (failure instanceof OwnerApiError && ["expired", "locked", "already_used"].includes(failure.code ?? "")) {
                const address = flow!.state.challenge!.email;
                await flow!.save({ challenge: null }); await flow!.sendCode(address);
              } else throw failure;
            }
          })}>Send again</button>
          <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => { setError(""); setCode(""); setStep("email"); }}>Change email</button>
        </div>}
        {owner && step !== "invitation" && <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => void run(async () => {
          const contactInvite = flow!.state.contactInvite;
          await flow!.signOut();
          if (contactInvite) await flow!.save({ flow: "create", contactInvite });
          setOwner(null); setEmail(""); setCode(""); setConsent(false); setConsentTouched(false);
          setStep(invitation ? "invitation" : chooseSpace ? "email" : "welcome");
        })}>Sign out</button>}
      </form>
      {compact && opening && addressPanel && <details class="desktop-welcome-address-disclosure">
        <summary>Use a space address</summary>
        {address()}
      </details>}
      </div>
      {split && <div class="desktop-welcome-address"><h2>Enter a space address</h2>
        {address()}
      </div>}
    </div>}
    {formError && <p class="gsv-login-error" role="alert">{formError}</p>}
    {step !== "welcome" && step !== "invitation" && (invitation || !chooseSpace) && <button class="gsv-auth-link desktop-welcome-back" type="button" disabled={busy} onClick={back}>Back</button>}
    {(loadError || (step === "welcome" && error)) && <button type="button" class="gsv-auth-link desktop-welcome-back" disabled={busy} onClick={() => flow ? void run(() => advance(flow)) : window.location.reload()}>Retry</button>}
  </section></AuthLayout>;
}
