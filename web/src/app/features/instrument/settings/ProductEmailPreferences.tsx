import { publicDeployment } from "../../../services/deployment";
import { useBrowserNavigation } from "../../../services/platform/BrowserNavigation";
import { useT } from "../../../i18n/locale";

/** Accounts owns this preference; a Kernel session cannot assert verified email ownership. */
export function ProductEmailPreferences() {
  const t = useT();
  const navigate = useBrowserNavigation();
  const accounts = publicDeployment().accountsOrigin;
  if (!accounts) return null;
  return <section class="settings-form"><h2>{t("settings.productEmails.title")}</h2>
    <p>{t("settings.productEmails.hint")}</p>
    <button class="ibtn" type="button" onClick={() => void navigate(`${accounts}/owner/email-preferences`)}>{t("settings.productEmails.manage")}</button>
  </section>;
}
