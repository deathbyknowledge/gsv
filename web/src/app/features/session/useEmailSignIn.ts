import { useEffect, useState } from "preact/hooks";
import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { readRecoveryOptions } from "../../services/session/accountRecovery";
import {
  createEmailSignInAttempt, emailSignInFailure, forgetEmailSignInAttempt, readEmailSignInAttempt, redeemEmailSignIn,
  sendEmailSignInCode, takeEmailSignInLink, type EmailSignInAttempt, type EmailSignInFailure,
} from "../../services/session/emailSignIn";
import { useT, type TextKey } from "../../i18n/locale";

/** Accounts waits this long before it mails the same address again. */
const RESEND_AFTER_MS = 60_000;
const FAILURE_TEXT = {
  invalid: "session.login.codeInvalid", expired: "session.login.codeExpired",
  locked: "session.login.codeLocked", unavailable: "session.login.emailUnavailable",
} satisfies Record<EmailSignInFailure, TextKey>;

export type EmailSignInView = {
  step: "email" | "code";
  email: string;
  code: string;
  notice: string | null;
  error: string | null;
  busy: boolean;
  canResend: boolean;
  onEmail: (value: string) => void;
  onCode: (value: string) => void;
  onSubmit: (event: Event) => void;
  onResend: () => void;
  onOtherEmail: () => void;
};

/**
 * Email sign-in on the sign-in screen, where the Ship offers it. The attempt this browser started survives reloads and
 * other tabs, so the button in the email can finish it, and a lost answer is retried with the same credential.
 */
export function useEmailSignIn({ session, snapshot, visible }: { session: SessionService; snapshot: SessionSnapshot; visible: boolean }) {
  const t = useT();
  const [link, setLink] = useState(takeEmailSignInLink);
  const [options, setOptions] = useState<{ url: string; available: boolean } | null>(null);
  const [method, setMethod] = useState<"email" | "password">("email");
  const [attempt, setAttempt] = useState<EmailSignInAttempt | null>(readEmailSignInAttempt);
  const [email, setEmail] = useState(attempt?.email ?? "");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(attempt ? t("session.login.codeSent", { email: attempt.email }) : null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<EmailSignInFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setClock] = useState(0);
  const loaded = options?.url === snapshot.url;
  const available = loaded && options.available;

  useEffect(() => {
    if (!visible || loaded) return;
    let current = true;
    void readRecoveryOptions(session.client, snapshot.url).then(({ emailSignIn }) => {
      if (current) setOptions({ url: snapshot.url, available: emailSignIn === true });
    });
    return () => { current = false; };
  }, [visible, loaded, session.client, snapshot.url]);

  // The resend action becomes available when Accounts would mail again.
  useEffect(() => {
    if (!attempt) return;
    const wait = attempt.createdAt + RESEND_AFTER_MS - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setClock((tick) => tick + 1), wait);
    return () => window.clearTimeout(timer);
  }, [attempt]);

  // A refusal says what to do about it; any other failure keeps its own message.
  const refused = (cause: Error | null) => {
    const reason = cause ? emailSignInFailure(cause) : null;
    setError(reason ? t(FAILURE_TEXT[reason]) : cause?.message ?? t("session.login.emailUnavailable"));
    return reason;
  };

  const signIn = async (current: EmailSignInAttempt, value: string) => {
    if (!/^\d{6}$/.test(value.replace(/\s/g, ""))) { setError(t("session.login.codeRequired")); return; }
    setBusy(true); setError(null);
    try {
      const opened = await redeemEmailSignIn(session.client, snapshot.url, current, value);
      await session.adoptSession({ username: opened.username, tokenId: opened.tokenId, token: current.credential, expiresAt: opened.expiresAt });
      forgetEmailSignInAttempt();
    } catch (cause) {
      setFailure(refused(cause instanceof Error ? cause : null));
    } finally {
      setBusy(false);
    }
  };

  // The email's button finishes the attempt it was sent for, here; another browser holds no secret for it.
  useEffect(() => {
    if (!link || !available || snapshot.phase !== "locked") return;
    setLink(null);
    if (attempt?.id === link.id) {
      setMethod("email");
      setCode(link.code);
      void signIn(attempt, link.code);
    } else {
      setError(t("session.login.linkElsewhere"));
    }
  }, [link, available, snapshot.phase]);

  const send = async (resend: boolean) => {
    const address = email.trim();
    if (!address.includes("@")) { setError(t("session.login.emailRequired")); return; }
    let next: EmailSignInAttempt;
    try {
      // A dead attempt cannot be mailed again, so it starts over.
      next = resend && attempt && failure !== "expired" && failure !== "locked" ? attempt : createEmailSignInAttempt(address);
    } catch {
      setError(t("session.login.storageUnavailable"));
      return;
    }
    setBusy(true); setError(null); setFailure(null);
    try {
      await sendEmailSignInCode(session.client, snapshot.url, next, next === attempt);
      setAttempt(next === attempt ? { ...next, createdAt: Date.now() } : next);
      setCode("");
      setNotice(t(resend ? "session.login.resent" : "session.login.codeSent", { email: address }));
    } catch (cause) {
      refused(cause instanceof Error ? cause : null);
    } finally {
      setBusy(false);
    }
  };

  const view: EmailSignInView = {
    step: attempt ? "code" : "email",
    email,
    code,
    notice,
    error,
    busy,
    canResend: attempt !== null && (failure === "expired" || failure === "locked" || attempt.createdAt + RESEND_AFTER_MS <= Date.now()),
    onEmail: (value) => { setError(null); setEmail(value); },
    onCode: (value) => { setError(null); setCode(value); },
    onSubmit: (event) => {
      event.preventDefault();
      if (busy) return;
      if (attempt) void signIn(attempt, code);
      else void send(false);
    },
    onResend: () => { if (!busy) void send(true); },
    onOtherEmail: () => {
      forgetEmailSignInAttempt();
      setAttempt(null); setCode(""); setNotice(null); setError(null); setFailure(null);
    },
  };
  return {
    /** Unknown until the Ship answers, so the screen shows no form it may take back. */
    loaded,
    method: available ? method : "password" as const,
    available,
    view,
    choose: (next: "email" | "password") => { setMethod(next); setError(null); },
  };
}
