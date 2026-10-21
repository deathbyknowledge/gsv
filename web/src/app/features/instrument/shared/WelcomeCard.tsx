import { useEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { rich, useT } from "../../../i18n/locale";
import "./welcome-card.css";

const WELCOME_SEEN = "ui/welcome_card_seen";

type Props = {
  /** Whether the card still stands over the chat: up, loading or failed to load. False once this person has dismissed it. */
  onOpenChange?: (open: boolean) => void;
};

/** The person's config follows them between the web app and Desktop. */
export function WelcomeCard({ onOpenChange }: Props = {}) {
  const t = useT();
  const { client, connected } = useGateway();
  const [ownerUid, setOwnerUid] = useState<number | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState(false);
  const pendingDismissal = useRef(false);
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
        const key = `users/${uid}/${WELCOME_SEEN}`;
        const { entries } = await client.sys.config.get({ key });
        if (cancelled) return;
        setLoadState("ready");
        if (!entries.some((entry) => entry.key === key && entry.value === "1")) setOwnerUid(uid);
      } catch (error) {
        if (!cancelled) {
          console.error("Could not load the welcome card state", error);
          setLoadState("failed");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [client, connected, loadState]);

  const open = loadState !== "ready" || ownerUid !== null;
  useEffect(() => { onOpenChange?.(open); }, [onOpenChange, open]);

  const dismiss = async () => {
    if (ownerUid === null || pendingDismissal.current) return;
    const key = `users/${ownerUid}/${WELCOME_SEEN}`;
    pendingDismissal.current = true;
    setDismissing(true);
    setDismissError(false);
    try {
      await client.sys.config.set({ key, value: "1" });
      setOwnerUid(null);
    } catch (cause) {
      console.error("Could not save the welcome card state", cause);
      setDismissError(true);
    } finally {
      pendingDismissal.current = false;
      setDismissing(false);
    }
  };

  if (loadState === "failed") return <aside class="welcome-card">
    <p role="alert">{t("shell.welcome.loadFailed")}</p>
    <button type="button" class="welcome-card-try" disabled={!connected} onClick={() => setLoadState("pending")}>{t("shell.retryButton")}</button>
  </aside>;
  if (ownerUid === null) return null;
  return <aside class="welcome-card" role="dialog" aria-labelledby="welcome-card-title">
    <button type="button" class="welcome-card-close" aria-label={t("shell.welcome.dismiss")} disabled={dismissing} onClick={dismiss}>×</button>
    <h2 id="welcome-card-title">{t("shell.welcome.title")}</h2>
    <p>{t("shell.welcome.intro")}</p>
    <p>{t("shell.welcome.early")}</p>
    <p>{rich(t("shell.welcome.contact"), {
      discord: <a href="https://discord.gg/hy9ExJJFvn" target="_blank" rel="noopener noreferrer">Discord</a>,
    })}</p>
    <p>{t("shell.welcome.thanks")}</p>
    <p>Kawah :)</p>
    {dismissError && <p role="alert">{t("shell.welcome.dismissFailed")}</p>}
    <button type="button" class="welcome-card-try" disabled={dismissing} onClick={dismiss}>{t("shell.welcome.start")}</button>
  </aside>;
}
