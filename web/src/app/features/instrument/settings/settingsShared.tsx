import { useLayoutEffect } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";

export type SettingsSectionProps = {
  account: ConsoleAccount;
  active: boolean;
  onDirty: (dirty: boolean) => void;
};

export function useSettingsDirty(dirty: boolean, report: (dirty: boolean) => void) {
  useLayoutEffect(() => { report(dirty); }, [dirty, report]);
}

export function SettingsError({ error }: { error: Error | null }) {
  return error ? <p class="settings-error" role="alert">{error.message}</p> : null;
}
