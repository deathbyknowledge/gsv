import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDismissOnOutsideClick } from "../app/features/instrument/shared/useDismissOnOutsideClick";

export function DesktopSpaceMenu({ origin, locked, onRecover, onDisconnect, onQuit, onMachine }: {
  origin: string | null;
  locked: boolean;
  onRecover(): void;
  onDisconnect(): void;
  onQuit(): void;
  onMachine?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const address = origin ? new URL(origin) : null;
  const name = address ? address.hostname === "localhost" || address.hostname.includes(":")
    ? address.host : address.hostname.split(".")[0] : "mock space";
  const close = () => { setOpen(false); button.current?.focus({ preventScroll: true }); };
  useDismissOnOutsideClick(open, () => [button.current, panel.current], () => setOpen(false));
  useLayoutEffect(() => { if (open) panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [open]);
  return <div class="desktop-space" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape" && open) { event.preventDefault(); close(); }
  }}>
    <button ref={button} type="button" class="desktop-space-name" aria-expanded={open}
      aria-controls="desktop-space-menu" title={address?.host ?? "Development space"}
      onClick={() => setOpen((current) => !current)}>{name}</button>
    {open && <div ref={panel} id="desktop-space-menu" class="desktop-space-menu" role="group" aria-label="Space">
      {address && <span class="desktop-space-address">{address.host}</span>}
      {locked && address && <button type="button" onClick={() => { setOpen(false); onRecover(); }}>recover account</button>}
      {onMachine && <button type="button" onClick={() => { setOpen(false); onMachine(); }}>this computer</button>}
      <button type="button" onClick={() => { setOpen(false); onDisconnect(); }}>disconnect</button>
      <button type="button" onClick={onQuit}>quit</button>
    </div>}
  </div>;
}
