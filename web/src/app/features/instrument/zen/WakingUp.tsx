import { useT } from "../../../i18n/locale";

/**
 * What a new owner reads while their Ship has not said anything yet: from the chat's first open,
 * through the first run's thinking, until the first message lands. The dots walk and the line breathes
 * so the wait does not look frozen; both hold still under reduced motion.
 */
export function WakingUp() {
  const t = useT();
  const line = t("chat.history.waking");
  return <p class="zen-waking" role="status" aria-label={`${line}…`}>
    <span aria-hidden="true">{line}</span>
    <span class="zen-waking-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
  </p>;
}
