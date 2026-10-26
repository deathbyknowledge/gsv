import type { AiModelsResult } from "@humansandmachines/gsv/protocol";
import type { ConsoleConfigEntry } from "../../../domain/system/consoleModels";
import type { ConsoleConfigWrite } from "../../../domain/system/consoleSettings";
import { t } from "../../../i18n/locale";
import { modelOrderWrites, type ModelStackDraft } from "./modelStack";

/** Validate the complete draft before any preference is written. */
export function preferenceWrites({ uid, config, models, order, reasoning, language, timezone }: {
  uid: number; config: readonly ConsoleConfigEntry[]; models?: AiModelsResult;
  order: ModelStackDraft | null; reasoning: string; language: string; timezone: string;
}): ConsoleConfigWrite[] {
  const entries: ConsoleConfigWrite[] = [];
  if (order) {
    if (!models) throw new Error(t("settings.models.unavailable"));
    entries.push(...modelOrderWrites(models, config, uid, order));
  }
  const changed = (suffix: string, value: string) => {
    const key = `users/${uid}/${suffix}`;
    if (value !== (config.find((entry) => entry.key === key)?.value ?? "")) entries.push({ key, value });
  };
  language = language.trim();
  timezone = timezone.trim();
  if (language) {
    try { Intl.getCanonicalLocales(language); }
    catch { throw new Error(t("settings.language.invalid")); }
  }
  if (timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
    catch { throw new Error(t("settings.timezone.invalid")); }
  }
  changed("ai/reasoning", reasoning);
  changed("locale/language", language);
  changed("locale/timezone", timezone);
  return entries;
}
