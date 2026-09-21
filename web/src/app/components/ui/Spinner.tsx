import type { ComponentChildren } from "preact";
import { AsciiAnimation } from "./AsciiAnimation";
import { spinnerScene, SPINNER_FONT_SIZE, SPINNER_FRAME_RATE } from "./spinnerScene";
import "./Spinner.css";

export interface SpinnerProps {
  /** Diameter in px (10–48). */
  size?: number;
}

/** Spinner — ported from Spinner.dc.html. Rotating loading ring. */
export function Spinner({ size = 22 }: SpinnerProps) {
  const resolution = size > 32 ? "panel" : "inline";
  const rows = resolution === "panel" ? 32 : 20;
  const stageSize = rows * SPINNER_FONT_SIZE * 0.7;
  return <span class="gsv-spinner" style={{ width: `${size}px`, height: `${size}px`,
    "--spinner-stage-size": `${stageSize}px`, "--spinner-scale": size / stageSize,
  }} aria-hidden="true">
    <AsciiAnimation inline scene={spinnerScene(resolution)} label="Loading" frameRate={SPINNER_FRAME_RATE} fontSize={SPINNER_FONT_SIZE} className="gsv-spinner-orbit" />
  </span>;
}

export type LoadingStateProps = { children: ComponentChildren; variant?: "inline" | "panel" };

export function LoadingState({ children, variant = "inline" }: LoadingStateProps) {
  return <span class={`gsv-loading-state is-${variant}`} role="status">
    <Spinner size={variant === "panel" ? 160 : 22} />
    <span>{children}</span>
  </span>;
}
