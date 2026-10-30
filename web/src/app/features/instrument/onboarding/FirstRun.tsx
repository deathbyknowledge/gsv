import { useEffect } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT } from "../../../i18n/locale";
import { useFirstRunState } from "./useFirstRunState";
import "./first-run.css";

type Props = {
  /** Whether the first run still stands in front of the chat: loading, failed, or not yet recorded. */
  onOpenChange?: (open: boolean) => void;
};

/** A new owner's chat wakes Ship the moment it opens; only a failure shows anything. */
export function FirstRun({ onOpenChange }: Props = {}) {
  const t = useT();
  const { connected } = useGateway();
  const { open, ownerUid, loadState, completing, completeError, retryLoad, complete } = useFirstRunState();
  useEffect(() => { onOpenChange?.(open); }, [onOpenChange, open]);
  useEffect(() => {
    if (ownerUid === null || completing || completeError) return;
    void complete();
  }, [ownerUid, completing, completeError, complete]);

  if (loadState !== "failed" && !completeError) return null;
  return <p class="first-run-notice" role="alert">
    {t("shell.firstRun.failed")}
    <button type="button" disabled={!connected || completing} onClick={loadState === "failed" ? retryLoad : () => { void complete(); }}>{t("shell.retryButton")}</button>
  </p>;
}
