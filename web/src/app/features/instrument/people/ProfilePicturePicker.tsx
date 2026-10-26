import { useEffect, useId, useRef, useState } from "preact/hooks";
import { useT } from "../../../i18n/locale";
import { Button } from "../../../components/ui/Button";
import { PROFILE_PICTURE_TYPES } from "./profilePicture";
import "./own-profile.css";

/** Choose, change or remove the profile's picture; the editor keeps the choice until the profile is saved. */
export function ProfilePicturePicker({ src, disabled, error, onChoose, onRemove }: {
  src: string | null; disabled: boolean; error: string | null; onChoose: (file: File) => void; onRemove: () => void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return <div class="people-picture" role="group" aria-labelledby={`${id}-label`}>
    <span class="gsv-ta-label gsv-sublabel" id={`${id}-label`}>{t("people.profile.picture")}</span>
    <div class="people-picture-row">
      {src ? <img class="people-picture-image" src={src} alt={t("people.profile.pictureAlt")} width={72} height={72} />
        : <span class="people-picture-image is-empty" aria-hidden="true" />}
      <input ref={input} type="file" accept={PROFILE_PICTURE_TYPES} hidden disabled={disabled} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // Choosing the same file again should still count as a choice.
        event.currentTarget.value = "";
        if (file) onChoose(file);
      }} />
      <Button variant="link" disabled={disabled} label={t(src ? "people.profile.pictureChange" : "people.profile.pictureChoose")} onClick={() => input.current?.click()} />
      {src && <Button variant="link" tone="neutral" disabled={disabled} label={t("people.profile.pictureRemove")} onClick={onRemove} />}
    </div>
    <p class="people-note">{t("people.profile.pictureNote")}</p>
    {error && <p class="people-error" role="alert">{error}</p>}
  </div>;
}

/** A URL for showing `blob`, released when the blob changes or the view goes. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
