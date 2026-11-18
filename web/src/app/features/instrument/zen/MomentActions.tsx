import { IconButton } from "../../../components/ui/IconButton";
import { Hint } from "../../../components/ui/Tooltip";
import { useT } from "../../../i18n/locale";
import { useCodeCopy } from "../shared/codeCopy";

/** The receipt control: the summary line it stands in for, and whether its receipt is open. */
export type ReceiptControl = { label: string; open: boolean; onToggle: () => void };

/** A message's own controls in a quiet row under it: copying its text, and the receipt of what Ship did before it. */
export function MomentActions({ text, receipt }: { text: string; receipt?: ReceiptControl }) {
  const t = useT();
  const { state, copy } = useCodeCopy(() => text, text);
  const outcome = state === "copied" ? t("chat.copy.done") : state === "failed" ? t("chat.copy.failed") : "";
  return (
    <div class={`zen-message-actions${receipt?.open ? " is-open" : ""}`}>
      {text ? (
        <Hint text={outcome || t("chat.copy.label")}>
          <IconButton glyph="copy" size={32} variant="floating" className={`zen-message-action${state === "idle" ? "" : ` is-${state}`}`}
            ariaLabel={t("chat.copy.label")} onClick={copy} />
        </Hint>
      ) : null}
      {receipt ? (
        <Hint text={receipt.label}>
          <IconButton glyph="receipt" size={32} variant="floating" className="zen-message-action"
            ariaLabel={receipt.label} expanded={receipt.open} onClick={receipt.onToggle} />
        </Hint>
      ) : null}
      <span class="zen-message-status" aria-live="polite">{outcome}</span>
    </div>
  );
}
