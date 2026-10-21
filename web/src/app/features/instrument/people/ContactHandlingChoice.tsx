import { useId } from "preact/hooks";
import { useT } from "../../../i18n/locale";

export function ContactHandlingChoice({ value, onChange, disabled }: {
  value: boolean | null;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  return <fieldset class="people-handling-choice" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend>{t("people.handling.question")}</legend>
    <label><input type="radio" name={id} value="human" checked={value === false} required onChange={() => onChange(false)} />
      <span>{t("people.handling.me")}<small>{t("people.handling.meHint")}</small></span>
    </label>
    <label><input type="radio" name={id} value="ship" checked={value === true} required onChange={() => onChange(true)} />
      <span>{t("people.handling.ship")}<small>{t("people.handling.shipHint")}</small></span>
    </label>
    <p class="people-note" id={`${id}-help`}>{t("people.handling.note")}</p>
  </fieldset>;
}
