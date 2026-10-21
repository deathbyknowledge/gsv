import { useEffect, useRef, useState } from "preact/hooks";
import { shortcutFromKey, shortcutLabel } from "./shortcutKeys";
import { useT, type TextKey } from "../../i18n/locale";

export function ShortcutRecorder({ label, value, disabled, capture, onChange }: {
  label: string; value: string; disabled: boolean;
  capture(active: boolean): Promise<boolean>;
  onChange(shortcut: string): void;
}) {
  const t = useT();
  const [listening, setListening] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<TextKey | null>(null);
  const held = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const finish = () => {
    if (!held.current) return;
    held.current = false;
    setListening(false);
    setReady(false);
    void capture(false);
  };
  useEffect(() => () => { if (held.current) { held.current = false; void capture(false); } }, [capture]);
  useEffect(() => {
    if (!listening) return;
    window.addEventListener("blur", finish);
    return () => window.removeEventListener("blur", finish);
  }, [listening]);
  useEffect(() => { if (disabled) finish(); }, [disabled]);
  return <div class="native-shortcut-field">
    <span>{label}</span>
    <button ref={button} type="button" class={`native-shortcut-recorder${listening ? " is-listening" : ""}`}
      disabled={disabled} aria-label={listening ? t("desktop.shortcut.pressLabel", { label }) : t("desktop.shortcut.valueLabel", { label, shortcut: shortcutLabel(value) })}
      aria-pressed={listening} onBlur={finish}
      onClick={async () => {
        if (held.current) return;
        held.current = true;
        setError(null); setListening(true); setReady(false);
        const available = await capture(true);
        if (!held.current) return;
        if (!available) { finish(); return; }
        setReady(true);
        button.current?.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (!held.current) return;
        event.stopPropagation();
        if (event.key !== "Tab") event.preventDefault();
        if (!ready) return;
        const result = shortcutFromKey(event);
        if (result.cancel) { setError(null); finish(); }
        else if (result.error) setError(result.error);
        else if (result.shortcut) { onChange(result.shortcut); setError(null); finish(); }
      }}>
      {listening ? t(ready ? "desktop.shortcut.press" : "desktop.shortcut.preparing") : <><kbd>{shortcutLabel(value)}</kbd><span>{t("desktop.shortcut.change")}</span></>}
    </button>
    {listening && <small>{t("desktop.shortcut.hint")}</small>}
    {error && <small class="native-input-error" role="alert">{t(error)}</small>}
  </div>;
}
