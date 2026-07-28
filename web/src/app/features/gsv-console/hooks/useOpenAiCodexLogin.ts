import { useEffect, useRef, useState } from "preact/hooks";

export type OpenAiCodexOAuthStart = {
  flowId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
};

export type OpenAiCodexOAuthPoll =
  | {
      status: "pending";
      intervalSeconds: number;
      expiresAt: number;
    }
  | {
      status: "complete";
    };

export type SettingsStatusTone = "pending" | "success" | "error";

type RunOpenAiCodexLoginFlowOptions = {
  signal: AbortSignal;
  onPoll: (flowId: string) => Promise<OpenAiCodexOAuthPoll>;
  onStart: () => Promise<OpenAiCodexOAuthStart>;
  onStarted: (started: OpenAiCodexOAuthStart) => void;
  onUpdated: (updated: OpenAiCodexOAuthStart) => void;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type UseOpenAiCodexLoginOptions = {
  active: boolean;
  resetKey: string;
  onCheckOpenAiCodexOAuth: () => Promise<boolean>;
  onPollOpenAiCodexOAuth: (flowId: string) => Promise<OpenAiCodexOAuthPoll>;
  onStartOpenAiCodexOAuth: () => Promise<OpenAiCodexOAuthStart>;
  setStatusText: (value: string) => void;
  setStatusTone: (value: SettingsStatusTone) => void;
};

export class OpenAiCodexLoginCancelledError extends Error {
  constructor() {
    super("OpenAI Codex login was restarted.");
    this.name = "OpenAiCodexLoginCancelledError";
  }
}

export async function runOpenAiCodexLoginFlow({
  signal,
  onPoll,
  onStart,
  onStarted,
  onUpdated,
  now = Date.now,
  wait = abortableDelay,
}: RunOpenAiCodexLoginFlowOptions): Promise<void> {
  const started = await onStart();
  throwIfCancelled(signal);
  onStarted(started);

  let intervalSeconds = Math.max(1, started.intervalSeconds);
  let expiresAt = started.expiresAt;
  while (now() < expiresAt) {
    await wait(intervalSeconds * 1000, signal);
    throwIfCancelled(signal);
    const poll = await onPoll(started.flowId);
    throwIfCancelled(signal);
    if (poll.status === "complete") {
      return;
    }
    intervalSeconds = Math.max(1, poll.intervalSeconds);
    expiresAt = poll.expiresAt;
    onUpdated({ ...started, intervalSeconds, expiresAt });
  }
  throw new Error("OpenAI Codex login expired. Start a new login and try again.");
}

export function useOpenAiCodexLogin({
  active,
  resetKey,
  onCheckOpenAiCodexOAuth,
  onPollOpenAiCodexOAuth,
  onStartOpenAiCodexOAuth,
  setStatusText,
  setStatusTone,
}: UseOpenAiCodexLoginOptions) {
  const [auth, setAuth] = useState<OpenAiCodexOAuthStart | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const attemptRef = useRef<AbortController | null>(null);

  useEffect(() => {
    attemptRef.current?.abort();
    attemptRef.current = null;
    setAuth(null);
    setConnected(false);
    setConnecting(false);
  }, [active, resetKey]);

  useEffect(() => () => attemptRef.current?.abort(), []);

  const runAttempt = async (checkStoredCredential: boolean) => {
    if (!active) {
      return;
    }

    attemptRef.current?.abort();
    const attempt = new AbortController();
    attemptRef.current = attempt;
    setAuth(null);
    setConnected(false);
    setConnecting(true);
    setStatusTone("pending");

    try {
      if (checkStoredCredential) {
        setStatusText("Checking OpenAI Codex login...");
        const hasStoredCredential = await onCheckOpenAiCodexOAuth();
        throwIfCancelled(attempt.signal);
        if (hasStoredCredential) {
          setConnected(true);
          setStatusTone("success");
          setStatusText("OpenAI Codex connected.");
          return;
        }
      }

      setStatusText("Starting OpenAI Codex login...");
      await runOpenAiCodexLoginFlow({
        signal: attempt.signal,
        onPoll: onPollOpenAiCodexOAuth,
        onStart: onStartOpenAiCodexOAuth,
        onStarted: (started) => {
          setAuth(started);
          globalThis.open?.(started.verificationUrl, "_blank", "noopener,noreferrer");
          setStatusText(`Enter code ${started.userCode} in OpenAI Codex login.`);
        },
        onUpdated: setAuth,
      });
      throwIfCancelled(attempt.signal);
      setConnected(true);
      setStatusTone("success");
      setStatusText("OpenAI Codex connected.");
    } catch (error) {
      if (error instanceof OpenAiCodexLoginCancelledError) {
        throw error;
      }
      if (attempt.signal.aborted) {
        throw new OpenAiCodexLoginCancelledError();
      }
      if (attemptRef.current === attempt) {
        setStatusTone("error");
        setStatusText(loginErrorMessage(error));
      }
      throw error;
    } finally {
      if (attemptRef.current === attempt) {
        attemptRef.current = null;
        setConnecting(false);
      }
    }
  };

  const connect = () => runAttempt(false);

  const beginConnect = () => {
    void connect().catch(() => undefined);
  };

  const ensureConnected = async () => {
    if (!active || connected) {
      return;
    }
    await runAttempt(true);
  };

  return {
    auth,
    beginConnect,
    connected,
    connecting,
    connect,
    ensureConnected,
    resetConnected: () => setConnected(false),
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new OpenAiCodexLoginCancelledError());
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    const cancel = () => {
      globalThis.clearTimeout(timeout);
      reject(new OpenAiCodexLoginCancelledError());
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new OpenAiCodexLoginCancelledError();
  }
}

function loginErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "Unable to connect OpenAI Codex.";
}
