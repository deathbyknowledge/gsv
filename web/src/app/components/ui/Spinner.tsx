import type { ComponentChildren } from "preact";
import { AsciiAnimation } from "./AsciiAnimation";
import { spinnerScene, SPINNER_FRAME_RATE } from "./spinnerScene";
import "./Spinner.css";

export interface SpinnerProps {
  /** Diameter in px (10–48). */
  size?: number;
}

/** Spinner — ported from Spinner.dc.html. Rotating loading ring. */
export function Spinner({ size = 22 }: SpinnerProps) {
  const resolution = size > 32 ? "panel" : "inline";
  const rows = resolution === "panel" ? 32 : 20;
  return <span class="gsv-spinner" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
    <AsciiAnimation inline scene={spinnerScene(resolution)} label="Loading" frameRate={SPINNER_FRAME_RATE} fontSize={size / (rows * 0.6)} className="gsv-spinner-orbit" />
  </span>;
}

export type LoadingStateProps = { children: ComponentChildren; variant?: "inline" | "panel" };

export function LoadingState({ children, variant = "inline" }: LoadingStateProps) {
  return <span class={`gsv-loading-state is-${variant}`} role="status">
    <Spinner size={variant === "panel" ? 72 : 22} />
    <span>{children}</span>
  </span>;
}
