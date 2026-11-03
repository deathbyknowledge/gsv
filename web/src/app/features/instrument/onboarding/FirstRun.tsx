import { useEffect } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT } from "../../../i18n/locale";
import { FirstRunScreen } from "./FirstRunScreen";
import { useFirstRunState } from "./useFirstRunState";
import "./first-run.css";

type Props = {
  /** The Ship chat is the selected view; another view, or a work session, leaves the first run pending. */
  active: boolean;
  /** Whether the surface choice is on screen right now, so the chat beneath it can stay out of sight. */
  onShownChange?: (shown: boolean) => void;
};

/** A new owner's first run: where to message Ship stands in front of the chat until the person moves on. */
export function FirstRun({ active, onShownChange }: Props) {
  const t = useT();
  const { connected } = useGateway();
  const { ownerUid, loadState, completing, completeError, retryLoad, complete } = useFirstRunState();
  const shown = active && loadState === "ready" && ownerUid !== null;
  useEffect(() => { onShownChange?.(shown); }, [onShownChange, shown]);

  /* the failure stays recorded while another view is open; the notice waits for the chat */
  if (!active) return null;
  if (loadState === "failed") return <p class="first-run-notice" role="alert">
    {t("onboarding.surface.failed")}
    <button type="button" disabled={!connected} onClick={retryLoad}>{t("shell.retryButton")}</button>
  </p>;
  if (ownerUid === null) return null;
  return <FirstRunScreen ownerUid={ownerUid} completing={completing} completeError={completeError} onComplete={complete} />;
}
