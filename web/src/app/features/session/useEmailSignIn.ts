import { useEffect, useState } from "preact/hooks";
import type { SessionService, SessionSnapshot } from "../../services/session/sessionService";
import { readRecoveryOptions } from "../../services/session/accountRecovery";
import {
  createEmailSignInAttempt, emailSignInAttemptLive, emailSignInFailure, forgetEmailSignInAttempt, readEmailSignInAttempt,
  recordEmailSignInSent, redeemEmailSignIn, sendEmailSignInCode, takeEmailSignInLink, type EmailSignInAttempt, type EmailSignInFailure,
} from "../../services/session/emailSignIn";
import { useT, type TextKey } from "../../i18n/locale";

/** Accounts waits this long after it mails an address before it mails it again, even for a new attempt. */
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
  // A saved attempt the Ship never answered may still have mailed its code; sending repeats its start.
  const [saved] = useState(readEmailSignInAttempt);
  const [attempt, setAttempt] = useState<EmailSignInAttempt | null>(saved?.sentAt === undefined ? null : saved);
  // A start whose answer was lost may still have mailed its code.
  const [unanswered, setUnanswered] = useState<EmailSignInAttempt | null>(saved?.sentAt === undefined ? saved : null);
  const [email, setEmail] = useState(saved?.email ?? "");
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

  // The resend action becomes available when Accounts would mail again, counted from the Ship's answer, which comes after
  // Accounts sent the code.
  const resendAt = attempt ? (attempt.sentAt ?? attempt.createdAt) + RESEND_AFTER_MS : null;
  useEffect(() => {
    if (resendAt === null) return;
    const wait = resendAt - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setClock((tick) => tick + 1), wait);
    return () => window.clearTimeout(timer);
  }, [resendAt]);

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
    const linked = [attempt, unanswered].find((current) => current?.id === link.id);
    if (linked) {
      setMethod("email");
      setCode(link.code);
      void signIn(linked, link.code);
    } else {
      setError(t("session.login.linkElsewhere"));
    }
  }, [link, available, snapshot.phase]);

  const send = async (resend: boolean) => {
    const address = email.trim();
    if (!address.includes("@")) { setError(t("session.login.emailRequired")); return; }
    let next: EmailSignInAttempt;
    try {
      // A start without an answer is repeated: Accounts mails one attempt once, and would not mail a new one for the
      // same email this soon. A dead attempt cannot be mailed again, so it starts over.
      next = unanswered?.email === address && emailSignInAttemptLive(unanswered) ? unanswered
        : resend && attempt && failure !== "expired" && failure !== "locked" && emailSignInAttemptLive(attempt) ? attempt
        : createEmailSignInAttempt(address);
    } catch {
      setError(t("session.login.storageUnavailable"));
      return;
    }
    setBusy(true); setError(null); setFailure(null);
    try {
      await sendEmailSignInCode(session.client, snapshot.url, next, next === attempt);
      setAttempt(recordEmailSignInSent(next));
      setUnanswered(null);
      setCode("");
      setNotice(t(resend ? "session.login.resent" : "session.login.codeSent", { email: address }));
    } catch (cause) {
      if (next !== attempt) setUnanswered(next);
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
    canResend: resendAt !== null && resendAt <= Date.now(),
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
      setAttempt(null); setUnanswered(null); setCode(""); setNotice(null); setError(null); setFailure(null);
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
