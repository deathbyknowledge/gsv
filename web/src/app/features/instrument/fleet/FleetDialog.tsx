import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { RetainedView } from "../../../services/navigation/ViewActivity";

export function FleetDialog({ open, title, onClose, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  useLayoutEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useLayoutEffect(() => {
    const dialog = element.current;
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const outside = (event: MouseEvent | PointerEvent) => {
    const dialog = element.current;
    if (!dialog || event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };

  return <dialog ref={element} class="fleet-dialog" aria-labelledby="fleet-inspector-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { backdropPress.current = outside(event); }}
    onClick={(event) => {
      if (backdropPress.current && outside(event)) onClose();
      backdropPress.current = false;
    }}>
    <header class="fleet-dialog-head">
      <span id="fleet-inspector-title">{title}</span>
      <button type="button" class="fleet-text-action" aria-label="Close inspector" onClick={onClose}>close <kbd>esc</kbd></button>
    </header>
    <RetainedView active={open}>
      <section class="fleet-inspector">{children}</section>
    </RetainedView>
  </dialog>;
}
