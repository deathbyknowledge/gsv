import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useT } from "../app/i18n/locale";
import "./SignupDialog.css";

export function SignupDialog({ children }: { children: ComponentChildren }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(true);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  useLayoutEffect(() => () => { dialog.current?.close(); }, []);

  return <>
    {!open && <button class="gsv-auth-link signup-reopen" onClick={() => setOpen(true)}>{t("signup.reopen")}</button>}
    <dialog ref={dialog} class="signup-dialog" aria-label={t("session.welcome.title")}
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}>
      <div class="signup-dialog-controls"><button type="button" class="gsv-auth-link" aria-label={t("signup.closeLabel")} onClick={() => setOpen(false)}>{t("signup.close")}</button></div>
      {children}
    </dialog>
  </>;
}
