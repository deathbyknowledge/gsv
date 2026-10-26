import type { VNode } from "preact";
import { Hint } from "../../../components/ui/Tooltip";
import type { Translate } from "../../../i18n/locale";

/** "open network" in a sentence about the public profile; hovering, focusing or tapping it says what a public profile there means. */
export function openNetworkTerm(t: Translate): VNode {
  return <span class="people-term">
    <Hint text={t("people.profile.openNetworkTip")} openOnTap>
      <span class="people-term-label" tabIndex={0}>{t("people.profile.openNetwork")}</span>
    </Hint>
  </span>;
}
