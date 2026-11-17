import { useEffect, useRef, useState } from "preact/hooks";
import type { ConsoleIdentityLink } from "../../../../domain/system/consoleModels";
import type { ConsoleAdapterPairingLink } from "../../../../services/system/consoleService";
import type { ManagedTelegramDependencies } from "./ManagedTelegramOnboardingFlow";

/** How often the page looks for the new connection while it waits, in case it misses the live notice. */
const LINK_POLL_MS = 5_000;

/** A minted link and when it stops working by this device's clock. */
export type HeldLink = ConsoleAdapterPairingLink & { localExpiresAt: number };

export type MessengerLinkOptions = {
  adapterId: string;
  /** Whether to make the first link now: the messenger takes links and the host is not holding pairing back. */
  ready: boolean;
  /** The owner's messenger links, refreshed by the host when the Kernel announces a change. */
  links?: readonly ConsoleIdentityLink[];
  onRefreshLinks?: () => void;
  create: ReturnType<ManagedTelegramDependencies["useCreateConsoleAdapterPairingLink"]>;
  disconnect: ReturnType<ManagedTelegramDependencies["useDisconnectConsoleAdapterPairing"]>;
};

export type MessengerLink = {
  /** Whether the flow has made, or is making, its own link. */
  started: boolean;
  link: HeldLink | null;
  /** The connection this link made, once the Kernel reports it. */
  connected: ConsoleIdentityLink | null;
  waiting: boolean;
  expired: boolean;
  /** Why the last link, or the disconnection of a wrong account, failed. */
  error: string;
  mint: () => Promise<void>;
  /** Disconnects an account that is not the person's, then makes a new link. */
  disconnectWrongAccount: () => Promise<void>;
};

/**
 * One messenger's single-use link: made as soon as the flow opens, watched until the Kernel reports
 * the connection it made (live notices, plus a poll while the page is visible), and replaced on
 * request once it expires or fails. A connection older than the link is someone's earlier one, not
 * the answer to it.
 */
export function useMessengerLink({ adapterId, ready, links, onRefreshLinks, create, disconnect }: MessengerLinkOptions): MessengerLink {
  const [link, setLink] = useState<HeldLink | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const expired = link !== null && now >= link.localExpiresAt;
  const connected = link
    ? links?.find((entry) => entry.adapter === adapterId && entry.linkedAt !== undefined && entry.linkedAt >= link.createdAt) ?? null
    : null;
  const waiting = link !== null && !expired && connected === null;

  const mint = async () => {
    if (create.isPending) return;
    setError("");
    try {
      const next = await create.mutateAsync(adapterId);
      const received = Date.now();
      setNow(received);
      setLink({ ...next, localExpiresAt: received + (next.expiresAt - next.createdAt) });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  // Opening the flow is the choice to connect, so the link is ready before the person reaches for it.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started || !ready) return;
    setStarted(true);
    void mint();
  }, [ready, started]);

  useEffect(() => {
    if (!waiting || !link) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, link.localExpiresAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [waiting, link]);

  const refresh = useRef(onRefreshLinks);
  refresh.current = onRefreshLinks;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      // A hidden tab hears the live notice when it returns, so it does not need to ask.
      if (document.visibilityState !== "hidden") refresh.current?.();
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  const disconnectWrongAccount = async () => {
    if (!connected || disconnect.isPending) return;
    setError("");
    try {
      await disconnect.mutateAsync({ adapter: connected.adapter, accountId: connected.accountId, actorId: connected.actorId });
      setLink(null);
      refresh.current?.();
      await mint();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return { started, link, connected, waiting, expired, error, mint, disconnectWrongAccount };
}
