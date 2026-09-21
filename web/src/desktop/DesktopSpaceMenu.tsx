import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { useDismissOnOutsideClick } from "../app/features/instrument/shared/useDismissOnOutsideClick";
import { InputTimingPanel } from "./InputTimingPanel";

export function DesktopSpaceMenu({ origin, locked, onRecover, onDisconnect, onQuit }: {
  origin: string | null;
  locked: boolean;
  onRecover(): void;
  onDisconnect(): void;
  onQuit(): void;
}) {
  const [open, setOpen] = useState<"space" | "timings" | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const address = origin ? new URL(origin) : null;
  const name = address ? address.hostname === "localhost" || address.hostname.includes(":")
    ? address.host : address.hostname.split(".")[0] : "mock space";
  const close = () => { setOpen(null); button.current?.focus({ preventScroll: true }); };
  useDismissOnOutsideClick(open === "space", () => [button.current, panel.current], () => setOpen(null));
  useLayoutEffect(() => { if (open === "space") panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F8" || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen((current) => current === "timings" ? null : "timings");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return <div class="desktop-space" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape" && open) { event.preventDefault(); close(); }
  }}>
    <button ref={button} type="button" class="desktop-space-name" aria-expanded={open === "space"}
      aria-controls="desktop-space-menu" title={address?.host ?? "Development space"}
      onClick={() => setOpen((current) => current === "space" ? null : "space")}>{name}</button>
    {open === "space" && <div ref={panel} id="desktop-space-menu" class="desktop-space-menu" role="group" aria-label="Space">
      {address && <span class="desktop-space-address">{address.host}</span>}
      {locked && address && <button type="button" onClick={() => { setOpen(null); onRecover(); }}>recover account</button>}
      <button type="button" onClick={() => setOpen("timings")}>input timings <kbd>F8</kbd></button>
      <button type="button" onClick={() => { setOpen(null); onDisconnect(); }}>disconnect</button>
      <button type="button" onClick={onQuit}>quit</button>
    </div>}
    {open === "timings" && createPortal(<InputTimingPanel onClose={close} />,
      button.current?.closest(".instrument-scaled, .instrument") ?? document.body)}
  </div>;
}
