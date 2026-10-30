import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";

/** The per-account flag the Kernel watches: a human writing "1" here activates Ship's initial onboarding. */
export const FIRST_RUN_SEEN = "ui/welcome_card_seen";
/** Where the person said they want to message Ship, recorded next to the flag. */
export const PREFERRED_SURFACE = "ui/preferred_surface";

export type PreferredSurface = "web" | "desktop" | "whatsapp" | "telegram";

export type FirstRunState = {
  /** The first run still stands in front of the chat: not loaded yet, failed to load, or not completed. */
  open: boolean;
  /** This person's uid while their first run is unfinished; null before loading, once finished, and for admins. */
  ownerUid: number | null;
  loadState: "pending" | "ready" | "failed";
  completing: boolean;
  completeError: boolean;
  retryLoad: () => void;
  complete: (choice: PreferredSurface) => Promise<void>;
};

/** A new owner's first run. The flag follows the account between the web app and Desktop. */
export function useFirstRunState(): FirstRunState {
  const { client, connected } = useGateway();
  const [ownerUid, setOwnerUid] = useState<number | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState(false);
  const pendingCompletion = useRef(false);
  const [loadState, setLoadState] = useState<"pending" | "ready" | "failed">("pending");

  useEffect(() => {
    if (!connected || loadState !== "pending") return;
    let cancelled = false;
    void (async () => {
      try {
        const { accounts } = await client.account.list({});
        const uid = accounts.find((account) => account.relation === "self")?.uid;
        if (uid === undefined || uid < 1000) {
          if (!cancelled) setLoadState("ready");
          return;
        }
        const key = `users/${uid}/${FIRST_RUN_SEEN}`;
        const { entries } = await client.sys.config.get({ key });
        if (cancelled) return;
        setLoadState("ready");
        if (!entries.some((entry) => entry.key === key && entry.value === "1")) setOwnerUid(uid);
      } catch (error) {
        if (!cancelled) {
          console.error("Could not load the first-run state", error);
          setLoadState("failed");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [client, connected, loadState]);

  /* the choice is recorded first; the flag goes last, since writing it wakes Ship */
  const complete = useCallback(async (choice: PreferredSurface) => {
    if (ownerUid === null || pendingCompletion.current) return;
    pendingCompletion.current = true;
    setCompleting(true);
    setCompleteError(false);
    try {
      await client.sys.config.set({ key: `users/${ownerUid}/${PREFERRED_SURFACE}`, value: choice });
      await client.sys.config.set({ key: `users/${ownerUid}/${FIRST_RUN_SEEN}`, value: "1" });
      setOwnerUid(null);
    } catch (cause) {
      console.error("Could not record the first run", cause);
      setCompleteError(true);
    } finally {
      pendingCompletion.current = false;
      setCompleting(false);
    }
  }, [client, ownerUid]);

  return {
    open: loadState !== "ready" || ownerUid !== null,
    ownerUid,
    loadState,
    completing,
    completeError,
    retryLoad: () => setLoadState("pending"),
    complete,
  };
}
