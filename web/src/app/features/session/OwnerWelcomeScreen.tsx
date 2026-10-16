import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { AuthLayout } from "./AuthLayout";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/TextInput";
import { Spinner } from "../../components/ui/Spinner";
import { WelcomeIllustration } from "./backgrounds/WelcomeIllustration";
import { PolicyConsentLabel } from "./PolicyLinks";
import { OwnerWelcome, OwnerApiError, type OwnerSession, type PendingSetup, type WelcomeState } from "../../services/session/ownerWelcome";
import "./LoginScreen.css";
import "./OwnerWelcomeScreen.css";

type Step = "welcome" | "invitation" | "claim" | "email" | "code" | "spaces";
type Props = {
  ready: boolean;
  resume: boolean;
  load(): Promise<OwnerWelcome>;
  onConnect(origin: string, onboardingToken?: string | null): Promise<void>;
  addressPanel?: (options: { disabled: boolean; connect(origin: string): Promise<void> }) => ComponentChildren;
  initialStep?: "welcome" | "claim" | "email";
  chooseSpace?: boolean;
  invitation?: { name?: string; origin?: string };
  compact?: boolean;
  /** Domain shown after the handle before Accounts has stated it; the signed-in session's domain wins. */
  spaceDomain?: string;
};

export function OwnerWelcomeScreen({ ready, resume, load, onConnect, addressPanel, initialStep = "welcome", chooseSpace = false, invitation, compact = false, spaceDomain: presumedDomain }: Props) {
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
  /** A handle Accounts refused at creation stays marked until it is edited, whatever the public check says. */
  const rejectedHandle = useRef<string | null>(null);
  const spaceDomain = owner?.spaceDomain ?? presumedDomain;

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
  const create = async (client: OwnerWelcome) => {
    const chosen = client.state.handle;
    if (!chosen || !client.state.operationId) { setStep("claim"); return; }
    try {
      const prepared = await client.prepare(chosen, client.state.operationId);
      await onConnect(prepared.origin, prepared.onboardingToken);
    } catch (failure) {
      // Accounts rejects a handle taken since it was checked; the claim step shows that beside the field.
      if (failure instanceof OwnerApiError && (failure.code === "handle_unavailable" || /^handle is /i.test(failure.message))) {
        rejectedHandle.current = chosen;
        setHandle(chosen); setHandleError(failure.message); setAvailability("unavailable"); setStep("claim");
        return;
      }
      // The code is spent once verified; any other creation failure is retried from the claim step under the same operation.
      setHandle(chosen); setStep("claim");
      throw failure;
    }
  };
  const openSetup = async (client: OwnerWelcome, setup: PendingSetup) => {
    await client.save({ flow: "create", operationId: setup.operationId, handle: setup.handle });
    // Signing in or restoring a session does not imply agreement to create a space.
    if (!consent) { setHandle(setup.handle); setStep("claim"); return; }
    await create(client);
  };
  const advance = async (client: OwnerWelcome) => {
    const session = await client.session();
    setOwner(session);
    if (!session) { setStep(client.state.challenge ? "code" : client.state.flow === "create" && !chooseSpace ? "claim" : "email"); return; }
    if (client.state.challenge) await client.save({ challenge: null });
    const pendingSetup = session.setups.find((setup) => setup.operationId === client.state.operationId);
    if (pendingSetup) { await openSetup(client, pendingSetup); return; }
    if (session.spaces.length || session.setups.length || client.state.flow === "open" || !session.signupEnabled) {
      setStep("spaces"); return;
    }
    if (client.state.handle && client.state.operationId && consent) { await create(client); return; }
    // Signing in or restoring a session does not imply agreement to create a space.
    setHandle(client.state.handle ?? ""); setStep("claim");
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
      setEmail(client.state.challenge?.email ?? ""); setHandle(client.state.handle ?? "");
      if (!invitation && (resume || client.state.challenge || client.state.operationId)) await advance(client);
    });
    return () => { mounted = false; };
  }, [ready]);

  useEffect(() => {
    if (rejectedHandle.current && handle.trim() === rejectedHandle.current) { setAvailability("unavailable"); return; }
    rejectedHandle.current = null;
    setHandleError("");
    if (!flow || step !== "claim" || !handle.trim()) { setAvailability("idle"); return; }
    // A pending setup already holds its handle for this owner; the public check would call it taken.
    if (owner?.setups.some((setup) => setup.operationId === flow.state.operationId && setup.handle === handle.trim())) { setAvailability("available"); return; }
    let active = true;
    setAvailability("checking");
    const timer = setTimeout(() => {
      void flow.available(handle.trim()).then((available) => { if (active) setAvailability(available === null ? "idle" : available ? "available" : "unavailable"); })
        .catch((failure) => {
          if (!active) return;
          setAvailability("idle");
          setHandleError(failure instanceof Error ? failure.message : "Could not check this handle. Try again.");
        });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [step, handle, flow, owner]);

  const titles = {
    welcome: "Welcome to Ship", invitation: invitation?.name ? `${invitation.name} invited you to Ship` : "You’re invited to Ship",
    claim: "Claim your ship", email: "Your email", code: "Check your email", spaces: "Your spaces",
  } satisfies Record<Step, string>;
  const creating = flow?.state.flow === "create";
  const requiresConsent = step === "claim";
  const consentError = requiresConsent && consentTouched && !consent;
  const formError = error === handleError ? loadError : error || loadError;
  const start = (intent: "open" | "create") => void run(async () => {
    setConsent(false); setConsentTouched(false);
    if (intent === "open") setStep("email");
    if (!flow) return;
    const change: Partial<WelcomeState> = { flow: intent, operationId: null, handle: null };
    await flow.save(change);
    // A remembered owner session skips the email fields; everyone else claims a handle and email together.
    if (intent === "create" && !flow.state.sessionSecret) { setHandle(""); setStep("claim"); }
    else await advance(flow);
  });
  const submit = (event: Event) => {
    event.preventDefault();
    if (requiresConsent && !consent) { setConsentTouched(true); return; }
    void run(async () => {
      if (!flow) return;
      if (step === "invitation") {
        await flow.save({ flow: "create" });
        await advance(flow);
      } else if (step === "claim") {
        await flow.chooseHandle(handle.trim());
        if (owner) await create(flow);
        else { await flow.sendCode(email.trim().toLowerCase()); setStep("code"); }
      } else if (step === "email") {
        await flow.sendCode(email.trim().toLowerCase()); setStep("code");
      } else if (step === "code") {
        await flow.verify(code); setCode(""); await advance(flow);
      }
    });
  };
  const actionDisabled = !flow || busy || (step === "claim" ? !handle.trim() || (!owner && !email.trim()) || availability === "unavailable" || !!handleError
    : step === "email" ? !email.trim() : step === "code" ? code.length !== 6 : false);
  const opening = step === "spaces" || step === "email";
  const codeHeading = step === "code" && creating && !!flow?.state.handle;
  const title = invitation && step === "email" ? "Join Ship"
    : !opening ? titles[step] : !compact ? "Open your space" : step === "spaces" ? "Choose your space" : "Sign in";
  const split = opening && !!addressPanel && !compact;
  const address = () => addressPanel?.({ disabled: busy, connect: (origin) => run(async () => {
    try { await onConnect(origin); }
    catch { throw new Error("Could not open this space. Try again."); }
  }) });
  const back = () => {
    setError("");
    if (step === "code") { setCode(""); setStep(creating && !chooseSpace ? "claim" : "email"); return; }
    setStep(invitation ? "invitation" : "welcome");
  };
  const action = step === "claim" ? "Create space" : step === "email" ? "Send code" : step === "code" ? "Confirm" : "Continue";

  return <AuthLayout visible surfaceClass="gsv-auth-surface-login"><section class={`desktop-welcome${step === "welcome" || split ? " desktop-welcome-wide" : ""}`}>
    {codeHeading
      ? <h1 class="desktop-welcome-handle"><span>@{flow?.state.handle}</span>{spaceDomain && <span class="desktop-welcome-handle-domain">.{spaceDomain}</span>}</h1>
      : <h1>{title}</h1>}
    {step === "welcome" ? <div class="desktop-welcome-columns desktop-welcome-choices">
      <button class="desktop-welcome-choice" type="button" aria-label="Create your space" disabled={!flow || busy} onClick={() => start("create")}>
        <WelcomeIllustration kind="create" />
        <span class="desktop-welcome-choice-title">Create your space <span aria-hidden="true">→</span></span>
        <span class="desktop-welcome-detail">Pick a handle, confirm your email</span>
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
      {codeHeading && <p class="desktop-welcome-lede">Almost there! We've sent a confirmation code to your email.</p>}
      <form key={step} class="gsv-login-fields" onSubmit={submit} aria-busy={busy}>
        {step === "invitation" && <div class="desktop-welcome-invitation">
          {invitation?.origin && <p class="desktop-welcome-detail">{invitation.origin}</p>}
          <p>Join Ship or open your space to connect.</p>
        </div>}
        {step === "claim" && <TextInput label="Handle" value={handle} onChange={(value) => { setHandle(value.toLowerCase()); setError(""); }} disabled={busy}
          prefix="@" suffix={spaceDomain ? `.${spaceDomain}` : undefined} placeholder="your-space"
          status={handleError || availability === "unavailable" ? "error" : availability === "available" ? "success" : "none"}
          message={handleError || (availability === "available" ? "Available" : availability === "unavailable" ? "Already taken" : "")}
          inputProps={{ autoFocus: true, autoCapitalize: "none", spellcheck: false, maxLength: 63 }} />}
        {(step === "email" || (step === "claim" && !owner)) && <TextInput label="Email" value={email} onChange={setEmail} disabled={busy} placeholder="you@example.com"
          inputProps={{ autoFocus: step === "email", type: "email", autoComplete: "email", maxLength: 254, required: true }} />}
        {requiresConsent && <div class={`gsv-owner-consent${consentError ? " is-error" : ""}`}>
          <div class="gsv-owner-consent-row">
            <input id={consentId} type="checkbox" required checked={consent} disabled={busy}
              aria-labelledby={`${consentId}-label`} aria-invalid={consentError ? true : undefined}
              aria-describedby={consentError ? `${consentId}-error` : undefined}
              onInvalid={() => setConsentTouched(true)}
              onChange={(event) => { setConsent(event.currentTarget.checked); setConsentTouched(true); }} />
            <PolicyConsentLabel id={consentId} />
          </div>
          {consentError && <p class="gsv-owner-consent-error" id={`${consentId}-error`} role="alert">Confirm your age and agreement to continue.</p>}
        </div>}
        {step === "code" && <TextInput label="Code" value={code} onChange={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))} disabled={busy}
          placeholder="000000" inputProps={{ autoFocus: true, inputMode: "numeric", autoComplete: "one-time-code", maxLength: 6 }} />}
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
        {step !== "spaces" && <button class="gsv-btn gsv-btn-primary gsv-btn-block desktop-welcome-submit" type="submit" aria-label={action} disabled={actionDisabled} autoFocus={step === "invitation"}>
          {busy ? <Spinner /> : <span class="gsv-btn-label">{action}</span>}
        </button>}
        {step === "code" && <div class="desktop-welcome-sent">
          <p class="desktop-welcome-detail">{codeHeading ? "Code sent to " : ""}{flow?.state.challenge?.email}</p>
          <span class="desktop-welcome-links">
            <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => void run(async () => {
              try { await flow!.sendCode(flow!.state.challenge!.email, true); }
              catch (failure) {
                if (failure instanceof OwnerApiError && ["expired", "locked", "already_used"].includes(failure.code ?? "")) {
                  const address = flow!.state.challenge!.email;
                  await flow!.save({ challenge: null }); await flow!.sendCode(address);
                } else throw failure;
              }
            })}>Send again</button>
            <button type="button" class="gsv-auth-link" disabled={busy} onClick={back}>Change email</button>
          </span>
        </div>}
        {owner && step !== "invitation" && <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => void run(async () => {
          const contactInvite = flow!.state.contactInvite;
          await flow!.signOut();
          if (contactInvite) await flow!.save({ flow: "create", contactInvite });
          setOwner(null); setEmail(""); setCode(""); setHandle(""); setConsent(false); setConsentTouched(false);
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
