import type { JSX } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { resolvePlacement } from "../../components/ui/Tooltip";
import "./PolicySummaryLink.css";

type PolicySummaryLinkProps = {
  title: string;
  href: string;
  introduction: string;
  points: readonly [string, string];
};

export function PolicySummaryLink({ title, href, introduction, points }: PolicySummaryLinkProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>();
  const openOnPointerDown = useRef(false);
  const [open, setOpen] = useState(false);

  const clearTimer = () => window.clearTimeout(timerRef.current);
  const place = () => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const placement = resolvePlacement(trigger.getBoundingClientRect(), panel.offsetWidth, panel.offsetHeight, "top-end");
    panel.style.left = `${placement.left}px`;
    panel.style.top = `${Math.max(8, Math.min(placement.top, window.innerHeight - panel.offsetHeight - 8))}px`;
  };
  const show = () => {
    clearTimer();
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const theme = getComputedStyle(trigger);
    for (const property of ["--gsv-font-prose", "--panel", "--border", "--text", "--text-dim", "--accent", "--void"]) {
      panel.style.setProperty(property, theme.getPropertyValue(property));
    }
    panel.showPopover();
    place();
  };
  const leave = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      if (document.activeElement !== triggerRef.current && !panelRef.current?.contains(document.activeElement)) {
        panelRef.current?.hidePopover();
      }
    }, 150);
  };
  const click = (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.detail === 0 ? panelRef.current?.matches(":popover-open") : openOnPointerDown.current) panelRef.current?.hidePopover();
    else show();
  };

  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return <>
    <button ref={triggerRef} type="button" class="gsv-policy-summary-trigger"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-describedby={`${id}-description`}
      onPointerDown={() => {
        openOnPointerDown.current = panelRef.current?.matches(":popover-open") ?? false;
      }}
      onClick={click} onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(); }} onBlur={leave}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        clearTimer();
        timerRef.current = window.setTimeout(show, 300);
      }} onPointerLeave={(event) => { if (event.pointerType === "mouse") leave(); }}>{title}</button>
    {createPortal(<>
      <span id={`${id}-description`} class="gsv-tt-desc" aria-hidden="true">{introduction} {points.join(" ")}</span>
      <div ref={panelRef} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}
        class="gsv-policy-summary" onToggle={(event) => setOpen(event.newState === "open")}
        onPointerEnter={clearTimer} onPointerLeave={(event) => { if (event.pointerType === "mouse") leave(); }} onFocusIn={clearTimer} onFocusOut={leave}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{introduction}</p>
        <ul>{points.map((point) => <li key={point}>{point}</li>)}</ul>
        <a href={href} target="_blank" rel="noopener noreferrer">Read full {title}</a>
      </div>
    </>, document.body)}
  </>;
}
