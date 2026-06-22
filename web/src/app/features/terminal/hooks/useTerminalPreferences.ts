import { useCallback, useState } from "preact/hooks";
import {
  loadTerminalRunInBackgroundPreference,
  saveTerminalRunInBackgroundPreference,
} from "../domain/preferences";

export function useTerminalRunInBackgroundPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(loadTerminalRunInBackgroundPreference);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    saveTerminalRunInBackgroundPreference(next);
  }, []);

  return [enabled, setEnabled];
}
