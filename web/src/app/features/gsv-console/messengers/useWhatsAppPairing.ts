import type { AdapterConnectChallenge } from "@humansandmachines/gsv/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import type { ConsoleAdapterAccount } from "../domain/consoleModels";
import { useConnectConsoleAdapter, useConsoleAdapters } from "../hooks/useConsoleData";
import {
  actionableAdapterError,
  whatsappAccountPhone,
} from "./messengerPresentation";
import {
  isFreshWhatsAppPairingStatus,
  qrSecondsRemaining,
  whatsappAccountIdError,
  whatsappPairingStatusStartedAt,
  whatsappQrExpiresAt,
  whatsappQrSource,
} from "./whatsappPairing";

type SuccessfulConnectResult = Extract<ConnectConsoleAdapterResult, { ok: true }>;
export type WhatsAppPairingOutcome = "paired" | "challenge" | "error" | "superseded";

const STATUS_POLL_INTERVAL_MS = 2_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function connectedResult(account: ConsoleAdapterAccount): SuccessfulConnectResult {
  return {
    ok: true,
    adapter: account.adapter,
    accountId: account.accountId,
    connected: account.connected,
    authenticated: account.authenticated,
  };
}

export function useWhatsAppPairing({
  accountId,
  forceRelink,
  pairScreenActive,
  reconnectExisting,
}: {
  accountId: string;
  forceRelink: boolean;
  pairScreenActive: boolean;
  reconnectExisting: boolean;
}) {
  const connect = useConnectConsoleAdapter();
  const normalizedAccountId = accountId.trim();
  const accountScopeRef = useRef({ accountId: normalizedAccountId, version: 0 });
  if (accountScopeRef.current.accountId !== normalizedAccountId) {
    accountScopeRef.current = {
      accountId: normalizedAccountId,
      version: accountScopeRef.current.version + 1,
    };
  }
  const accountScopeVersion = accountScopeRef.current.version;
  const forcePendingRef = useRef(forceRelink);
  const requestPendingRef = useRef(false);
  const autoRefreshedChallengeRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [pairingScopeVersion, setPairingScopeVersion] = useState<number | null>(null);
  const [pairingStartedState, setPairingStarted] = useState(false);
  const [challengeState, setChallenge] = useState<AdapterConnectChallenge | null>(null);
  const [challengeIssuedAt, setChallengeIssuedAt] = useState(0);
  const [connectAttemptStartedAt, setConnectAttemptStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [resultState, setResult] = useState<SuccessfulConnectResult | null>(null);
  const [errorState, setError] = useState("");
  const pairingStateIsCurrent = pairingScopeVersion === accountScopeVersion;
  const pairingStarted = pairingStateIsCurrent && pairingStartedState;
  const challenge = pairingStateIsCurrent ? challengeState : null;
  const result = pairingStateIsCurrent ? resultState : null;
  const error = pairingStateIsCurrent ? errorState : "";

  useEffect(() => () => {
    mountedRef.current = false;
    accountScopeRef.current = {
      ...accountScopeRef.current,
      version: accountScopeRef.current.version + 1,
    };
  }, []);

  useEffect(() => {
    forcePendingRef.current = forceRelink;
    autoRefreshedChallengeRef.current = null;
    setPairingScopeVersion(null);
    setPairingStarted(false);
    setChallenge(null);
    setChallengeIssuedAt(0);
    setConnectAttemptStartedAt(0);
    setNow(Date.now());
    setResult(null);
    setError("");
  }, [forceRelink, normalizedAccountId]);

  const accountStatuses = useConsoleAdapters({
    accountId: normalizedAccountId,
    adapters: ["whatsapp"],
    enabled: pairingStarted && normalizedAccountId.length > 0,
    refetchInterval: pairingStarted && pairScreenActive && !result
      ? STATUS_POLL_INTERVAL_MS
      : false,
  });
  const liveAccount = accountStatuses.adapters.find(
    (account) => account.accountId === normalizedAccountId,
  ) ?? null;
  const pairingStatusStartedAt = whatsappPairingStatusStartedAt({
    challengeIssuedAt,
    connectAttemptStartedAt,
    reconnectExisting,
  });
  const livePairingConfirmed = pairingStarted
    && !connect.isPending
    && isFreshWhatsAppPairingStatus({
      authenticated: liveAccount?.authenticated ?? false,
      connected: liveAccount?.connected ?? false,
      pairingStatusStartedAt,
      statusUpdatedAt: accountStatuses.dataUpdatedAt,
    });
  const paired = Boolean(result?.connected && result.authenticated)
    || livePairingConfirmed;
  const pairedPhone = liveAccount ? whatsappAccountPhone(liveAccount) : "";
  const qrSource = useMemo(() => whatsappQrSource(challenge), [challenge]);
  const expiresAt = challenge && challengeIssuedAt
    ? whatsappQrExpiresAt(challenge, challengeIssuedAt)
    : 0;
  const secondsRemaining = expiresAt ? qrSecondsRemaining(expiresAt, now) : 0;

  useEffect(() => {
    if (
      !pairingStarted
      || !livePairingConfirmed
      || !liveAccount
    ) {
      return;
    }
    setResult(connectedResult(liveAccount));
    setChallenge(null);
    setError("");
  }, [liveAccount, livePairingConfirmed, pairingStarted]);

  useEffect(() => {
    if (!pairScreenActive || !challenge) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [challenge, pairScreenActive]);

  const pair = useCallback(async (): Promise<WhatsAppPairingOutcome> => {
    if (
      !mountedRef.current
      || whatsappAccountIdError(normalizedAccountId)
      || connect.isPending
      || requestPendingRef.current
    ) {
      return "error";
    }
    const requestAccountId = normalizedAccountId;
    const requestScopeVersion = accountScopeRef.current.version;
    const requestIsCurrent = () =>
      mountedRef.current
      && accountScopeRef.current.accountId === requestAccountId
      && accountScopeRef.current.version === requestScopeVersion;
    const attemptStartedAt = Date.now();
    requestPendingRef.current = true;
    setPairingScopeVersion(requestScopeVersion);
    setPairingStarted(true);
    setChallenge(null);
    setChallengeIssuedAt(0);
    setConnectAttemptStartedAt(attemptStartedAt);
    setNow(attemptStartedAt);
    setResult(null);
    setError("");
    const useForce = forcePendingRef.current;
    if (useForce) {
      forcePendingRef.current = false;
    }
    try {
      const next = await connect.mutateAsync({
        adapter: "whatsapp",
        accountId: requestAccountId,
        ...(useForce ? { config: { force: true } } : {}),
      });
      if (!requestIsCurrent()) {
        return "superseded";
      }
      if (!next.ok) {
        setError(actionableAdapterError("whatsapp", next.error));
        return "error";
      }
      if (next.connected && next.authenticated) {
        setResult(next);
        return "paired";
      }
      if (next.challenge?.type === "qr" && whatsappQrSource(next.challenge)) {
        const issuedAt = Date.now();
        setChallenge(next.challenge);
        setChallengeIssuedAt(issuedAt);
        setNow(issuedAt);
        return "challenge";
      }
      setError(
        next.challenge?.message
          || "WhatsApp started pairing but did not return a usable QR code. Try refreshing it.",
      );
      return "error";
    } catch (cause) {
      if (!requestIsCurrent()) {
        return "superseded";
      }
      setError(actionableAdapterError("whatsapp", errorText(cause)));
      return "error";
    } finally {
      requestPendingRef.current = false;
    }
  }, [connect, normalizedAccountId]);

  const autoRefreshKey = challenge && typeof challenge.expiresAt === "number"
    && Number.isFinite(challenge.expiresAt)
    ? challenge.expiresAt
    : challengeIssuedAt;

  useEffect(() => {
    if (
      !pairScreenActive
      || !challenge
      || secondsRemaining > 0
      || connect.isPending
      || autoRefreshedChallengeRef.current === autoRefreshKey
    ) {
      return;
    }
    autoRefreshedChallengeRef.current = autoRefreshKey;
    void pair();
  }, [autoRefreshKey, challenge, connect.isPending, pair, pairScreenActive, secondsRemaining]);

  return {
    error,
    isPending: connect.isPending,
    liveAccount,
    pair,
    paired,
    pairedPhone,
    pairingStarted,
    qrSource,
    result,
    secondsRemaining,
  };
}
