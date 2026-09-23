import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AuthLayout } from "../app/features/session/AuthLayout";
import { Button } from "../app/components/ui/Button";
import { SectionHeader } from "../app/components/ui/SectionHeader";
import { TextInput } from "../app/components/ui/TextInput";
import { Spinner } from "../app/components/ui/Spinner";
import { DesktopConnect } from "./DesktopConnect";
import { invoke } from "./bridge";
import { DesktopWelcome as WelcomeFlow, OwnerApiError, type OwnerSession, type OwnedInvite } from "./welcome";
import "../app/features/session/LoginScreen.css";

type Step = "welcome" | "address" | "invite" | "email" | "code" | "spaces" | "handle";
type Props = { ready: boolean; resume: boolean; onConnect(origin: string, onboardingToken?: string | null): Promise<void> };
const accountsOrigin = import.meta.env.VITE_GSV_ACCOUNTS_ORIGIN || "https://gsv.space";

export function DesktopWelcome({ ready, resume, onConnect }: Props) {
  const [flow, setFlow] = useState<WelcomeFlow | null>(null);
  const [step, setStep] = useState<Step>("welcome");
  const [owner, setOwner] = useState<OwnerSession | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [handle, setHandle] = useState("");
  const [availability, setAvailability] = useState<"idle" | "checking" | "available" | "unavailable">("idle");
  const suffix = useMemo(() => `.${new URL(accountsOrigin).hostname}`, []);

  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not continue. Try again.");
      if (failure instanceof OwnerApiError && failure.code === "signed_out") { setOwner(null); setStep("email"); }
    } finally { pending.current = false; setBusy(false); }
  };
  const openInvite = async (client: WelcomeFlow, invite: OwnedInvite) => {
    await client.save({ flow: "create", inviteId: invite.id, handle: invite.handle });
    if (!invite.handle) { setHandle(""); setStep("handle"); return; }
    const prepared = await client.prepare(invite.id, invite.handle);
    await onConnect(prepared.origin, prepared.onboardingToken);
  };
  const advance = async (client: WelcomeFlow) => {
    const session = await client.session();
    setOwner(session);
    if (!session) { setStep(client.state.challenge ? "code" : "email"); return; }
    if (client.state.challenge) await client.save({ challenge: null });
    if (client.state.flow === "create" && client.state.inviteCode) {
      setStep("invite");
      await openInvite(client, await client.claim());
    } else if (client.state.flow === "create" && client.state.inviteId) {
      const invite = session.invites.find((item) => item.id === client.state.inviteId && !["revoked", "expired"].includes(item.state));
      if (invite) await openInvite(client, invite);
      else setStep("spaces");
    } else setStep("spaces");
  };

  useEffect(() => {
    if (!ready) return;
    let mounted = true;
    void run(async () => {
      const snapshot = await invoke("desktop_welcome");
      if (!mounted) return;
      const client = new WelcomeFlow(snapshot, { save: (revision, value) => invoke("desktop_save_welcome", { revision, value }) }, accountsOrigin);
      setFlow(client);
      setEmail(client.state.challenge?.email ?? ""); setInviteCode(client.state.inviteCode ?? "");
      if (resume || client.state.challenge || client.state.inviteCode || (client.state.flow === "create" && client.state.inviteId)) await advance(client);
    });
    return () => { mounted = false; };
  }, [ready]);

  useEffect(() => {
    if (!flow || step !== "handle" || !handle.trim()) { setAvailability("idle"); return; }
    let active = true;
    setAvailability("checking");
    const timer = setTimeout(() => {
      void flow.available(handle.trim()).then((available) => { if (active) setAvailability(available ? "available" : "unavailable"); })
        .catch(() => { if (active) setAvailability("idle"); });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [step, handle, flow]);

  if (step === "address") return <div class="desktop-welcome-address"><DesktopConnect ready={ready} onConnect={onConnect} />
    <button class="gsv-auth-link" type="button" onClick={() => setStep("welcome")}>Back</button></div>;
  const titles: Record<Exclude<Step, "address">, string> = {
    welcome: "Welcome to GSV", invite: "Create your space", email: "Your email", code: "Check your email", spaces: "Your spaces", handle: "Choose your handle",
  };
  const start = (intent: "open" | "create") => void run(async () => {
    if (!flow) return;
    await flow.save({ flow: intent, inviteCode: null, inviteId: null, handle: null });
    if (intent === "create") setStep("invite");
    else await advance(flow);
  });
  const submit = (event: Event) => {
    event.preventDefault();
    void run(async () => {
      if (!flow) return;
      if (step === "invite") {
        await flow.save({ flow: "create", inviteCode: inviteCode.trim(), inviteId: null, handle: null });
        await advance(flow);
      } else if (step === "email") {
        await flow.sendCode(email.trim().toLowerCase()); setStep("code");
      } else if (step === "code") {
        await flow.verify(code); setCode(""); await advance(flow);
      } else if (step === "handle" && flow.state.inviteId) {
        const prepared = await flow.prepare(flow.state.inviteId, handle.trim());
        await onConnect(prepared.origin, prepared.onboardingToken);
      }
    });
  };
  const actionDisabled = !flow || busy || (step === "invite" ? !inviteCode.trim() : step === "email" ? !email.trim()
    : step === "code" ? code.length !== 6 : step === "handle" ? !handle.trim() || availability === "unavailable" : false);

  return <AuthLayout visible surfaceClass="gsv-auth-surface-login"><section class="gsv-login-panel desktop-welcome">
    <SectionHeader title={titles[step]} titleSize="title" divider />
    <div class="gsv-login-body">
      <form key={step} class="gsv-login-fields" onSubmit={submit} aria-busy={busy}>
        {step === "welcome" && <>
          <Button label="Open your space" block disabled={!flow || busy} onClick={() => start("open")} />
          <Button label="Create your space" variant="secondary" block disabled={!flow || busy} onClick={() => start("create")} />
        </>}
        {step === "invite" && <TextInput label="Invite code" value={inviteCode} onChange={setInviteCode} disabled={busy}
          placeholder="Paste your code" inputProps={{ autoFocus: true, autoComplete: "off", spellcheck: false, maxLength: 128 }} />}
        {step === "email" && <TextInput label="Email" value={email} onChange={setEmail} disabled={busy} placeholder="you@example.com"
          inputProps={{ autoFocus: true, type: "email", autoComplete: "email", maxLength: 254, required: true }} />}
        {step === "code" && <>
          <p class="desktop-welcome-detail">{flow?.state.challenge?.email}</p>
          <TextInput label="Code" value={code} onChange={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))} disabled={busy}
            placeholder="000000" inputProps={{ autoFocus: true, inputMode: "numeric", autoComplete: "one-time-code", maxLength: 6 }} />
        </>}
        {step === "handle" && <TextInput label="Handle" value={handle} onChange={setHandle} disabled={busy} suffix={suffix}
          placeholder="your-name" status={availability === "available" ? "success" : availability === "unavailable" ? "error" : "none"}
          message={availability === "available" ? "Available" : availability === "unavailable" ? "Already taken" : ""}
          inputProps={{ autoFocus: true, autoCapitalize: "none", spellcheck: false, maxLength: 63 }} />}
        {step === "spaces" && <>
          <p class="desktop-welcome-detail">{owner?.email}</p>
          {owner?.spaces.map((space) => <Button key={space.canonicalOrigin} label={space.handle} variant="secondary" block disabled={busy}
            onClick={() => void run(() => onConnect(space.canonicalOrigin))} />)}
          {owner?.invites.filter((invite) => ["claimed", "provisioning"].includes(invite.state)).map((invite) => <Button key={invite.id}
            label={invite.handle ? `Continue ${invite.handle}` : "Choose your handle"} variant="secondary" block disabled={busy}
            onClick={() => void run(() => openInvite(flow!, invite))} />)}
          {!owner?.spaces.length && !owner?.invites.some((invite) => ["claimed", "provisioning"].includes(invite.state)) && <p class="desktop-welcome-detail">No spaces yet.</p>}
          <Button label="Use an invite" disabled={busy} block onClick={() => start("create")} />
        </>}
        {error && <p class="gsv-login-error" role="alert">{error}</p>}
        {!["welcome", "spaces"].includes(step) && <button class="gsv-btn gsv-btn-primary gsv-btn-block desktop-welcome-submit" type="submit" disabled={actionDisabled}>
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
        {["welcome", "email", "spaces"].includes(step) && <button class="gsv-auth-link" type="button" disabled={busy} onClick={() => { setError(""); setStep("address"); }}>Enter a space address</button>}
        {owner && step !== "welcome" && <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => void run(async () => {
          await flow!.signOut(); setOwner(null); setEmail(""); setCode(""); setInviteCode(""); setStep("welcome");
        })}>Sign out</button>}
        {step !== "welcome" && <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => { setError(""); setStep("welcome"); }}>Back</button>}
        {step === "welcome" && error && <button type="button" class="gsv-auth-link" disabled={busy} onClick={() => flow ? void run(() => advance(flow)) : window.location.reload()}>Retry</button>}
      </form>
    </div>
  </section></AuthLayout>;
}
