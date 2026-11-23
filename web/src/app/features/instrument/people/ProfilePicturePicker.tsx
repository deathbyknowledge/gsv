import { useEffect, useId, useRef, useState } from "preact/hooks";
import { useT } from "../../../i18n/locale";
import { Button } from "../../../components/ui/Button";
import { PROFILE_PICTURE_TYPES, profilePicture, type ProfilePicture } from "./profilePicture";
import "./own-profile.css";

/**
 * Choose, change or remove the profile's picture. A chosen file is cropped and encoded here, and says
 * when it can't be read; the editor keeps the choice until the profile is saved.
 */
export function ProfilePicturePicker({ src, disabled, error, onChoose, onRemove }: {
  src: string | null; disabled: boolean; error: string | null; onChoose: (picture: ProfilePicture) => void; onRemove: () => void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const shownError = unreadable ?? error;
  return <div class="people-picture" role="group" aria-labelledby={`${id}-label`}>
    <span class="gsv-ta-label gsv-sublabel" id={`${id}-label`}>{t("people.profile.picture")}</span>
    <div class="people-picture-row">
      {src ? <img class="people-picture-image" src={src} alt={t("people.profile.pictureAlt")} width={72} height={72} />
        : <span class="people-picture-image is-empty" aria-hidden="true" />}
      <input ref={input} type="file" accept={PROFILE_PICTURE_TYPES} hidden disabled={disabled} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // Choosing the same file again should still count as a choice.
        event.currentTarget.value = "";
        if (!file) return;
        setUnreadable(null);
        void profilePicture(file).then(onChoose, (cause: unknown) => setUnreadable(cause instanceof Error ? cause.message : t("people.profile.pictureUnreadable")));
      }} />
      <Button variant="link" disabled={disabled} label={t(src ? "people.profile.pictureChange" : "people.profile.pictureChoose")} onClick={() => input.current?.click()} />
      {src && <Button variant="link" tone="neutral" disabled={disabled} label={t("people.profile.pictureRemove")} onClick={() => { setUnreadable(null); onRemove(); }} />}
    </div>
    <p class="people-note">{t("people.profile.pictureNote")}</p>
    {shownError && <p class="people-error" role="alert">{shownError}</p>}
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
