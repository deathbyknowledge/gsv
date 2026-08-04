import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  AccountApi,
  AccountApiError,
  type PublicAccountConfig,
} from "../api";
import { initialInstallationId } from "./domain";
import { getPasskeyAssertion } from "../passkey";
import type {
  AccountSession,
  ManagedTelegramClaimInspection,
  ManagedTelegramLink,
} from "./types";

export type TelegramLinkView =
  | { kind: "loading" }
  | { kind: "missing_claim" }
  | {
      kind: "authentication";
      config: PublicAccountConfig | null;
      pending: boolean;
      prompt: string;
      error?: string;
      resetKey: number;
    }
  | { kind: "claim_rejected"; reason: "invalid" | "expired" | "used" }
  | {
      kind: "ready";
      session: AccountSession;
      inspection: ManagedTelegramClaimInspection;
      selectedInstallationId: string | null;
      pending: boolean;
      error?: string;
    }
  | { kind: "complete"; link: ManagedTelegramLink }
  | { kind: "failure"; message: string };

export function useTelegramLink(
  claimToken: string | null,
  apiOverride?: AccountApi,
) {
  const api = useMemo(() => apiOverride ?? new AccountApi(), [apiOverride]);
  const [view, setView] = useState<TelegramLinkView>({ kind: "loading" });
  const selectedInstallationId = useRef<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const config = useRef<PublicAccountConfig | null>(null);
  const resetKey = useRef(0);

  useEffect(() => {
    let active = true;
    if (!claimToken) {
      setView({ kind: "missing_claim" });
      return () => {
        active = false;
      };
    }
    void bootstrap().catch((error) => {
      if (active) setView({ kind: "failure", message: publicError(error) });
    });
    return () => {
      active = false;
    };

    async function bootstrap() {
      const session = await api.session();
      if (!active) return;
      if (!session.authenticated) {
        await enterAuthentication("Sign in to choose the GSV this account can reach");
        return;
      }
      await inspect(session);
    }

    async function inspect(session: AccountSession) {
      const result = await api.inspectTelegramClaim(claimToken!);
      if (!active) return;
      if (!result.ok) {
        setView({ kind: "claim_rejected", reason: result.reason });
        return;
      }
      selectedInstallationId.current = initialInstallationId(
        result,
        selectedInstallationId.current ?? undefined,
      );
      setView({
        kind: "ready",
        session,
        inspection: result,
        selectedInstallationId: selectedInstallationId.current,
        pending: false,
      });
    }

    async function enterAuthentication(prompt: string) {
      setView({
        kind: "authentication",
        config: null,
        pending: true,
        prompt,
        resetKey: resetKey.current,
      });
      config.current ??= await api.publicConfig();
      if (!active) return;
      setView({
        kind: "authentication",
        config: config.current,
        pending: false,
        prompt,
        resetKey: resetKey.current,
      });
    }
  }, [api, claimToken]);

  function selectInstallation(installationId: string) {
    selectedInstallationId.current = installationId;
    setView((current) => current.kind === "ready"
      ? { ...current, selectedInstallationId: installationId, error: undefined }
      : current);
  }

  async function authenticate(turnstileToken: string) {
    if (!claimToken || view.kind !== "authentication" || view.pending) return;
    const authenticationView = view;
    setView({ ...authenticationView, pending: true, error: undefined });
    try {
      const challenge = await api.beginPasskeyAuthentication(turnstileToken);
      const response = await getPasskeyAssertion(challenge.options);
      await api.finishPasskeyAuthentication({
        challengeId: challenge.challengeId,
        response,
      });
      const session = await api.session();
      if (!session.authenticated) {
        throw new Error("The new account session was not available");
      }
      const result = await api.inspectTelegramClaim(claimToken);
      if (!result.ok) {
        setView({ kind: "claim_rejected", reason: result.reason });
        return;
      }
      selectedInstallationId.current = initialInstallationId(
        result,
        selectedInstallationId.current ?? undefined,
      );
      setView({
        kind: "ready",
        session,
        inspection: result,
        selectedInstallationId: selectedInstallationId.current,
        pending: false,
      });
    } catch (error) {
      resetKey.current += 1;
      setView({
        ...authenticationView,
        pending: false,
        error: passkeyError(error),
        resetKey: resetKey.current,
      });
    }
  }

  async function confirm() {
    if (
      !claimToken
      || view.kind !== "ready"
      || view.pending
      || !view.selectedInstallationId
    ) {
      return;
    }
    const readyView = view;
    setView({ ...readyView, pending: true, error: undefined });
    try {
      const link = await api.confirmTelegramClaim({
        claimToken,
        installationId: view.selectedInstallationId,
        idempotencyKey: idempotencyKey.current,
      });
      setView({ kind: "complete", link });
    } catch (error) {
      if (
        error instanceof AccountApiError
        && (error.status === 401 || error.status === 403)
      ) {
        resetKey.current += 1;
        let nextConfig = config.current;
        try {
          nextConfig ??= await api.publicConfig();
          config.current = nextConfig;
        } catch (configError) {
          setView({ kind: "failure", message: publicError(configError) });
          return;
        }
        setView({
          kind: "authentication",
          config: nextConfig,
          pending: false,
          prompt: "Confirm with your passkey before changing Telegram access",
          resetKey: resetKey.current,
        });
        return;
      }
      const rejection = claimRejection(error);
      if (rejection) {
        setView({ kind: "claim_rejected", reason: rejection });
        return;
      }
      setView({ ...readyView, pending: false, error: publicError(error) });
    }
  }

  function restart() {
    window.location.reload();
  }

  return { view, authenticate, confirm, selectInstallation, restart };
}

function claimRejection(
  error: unknown,
): "invalid" | "expired" | "used" | null {
  if (!(error instanceof AccountApiError)) return null;
  const message = error.message.toLowerCase();
  if (message.includes("expired")) return "expired";
  if (message.includes("already used")) return "used";
  if (error.status === 410) return "used";
  if (message.includes("invalid")) return "invalid";
  return null;
}

function passkeyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Passkey authentication was cancelled or timed out";
  }
  return publicError(error);
}

function publicError(error: unknown): string {
  if (error instanceof AccountApiError || error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}
