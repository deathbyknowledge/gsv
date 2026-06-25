import "./Spinner.css";

export interface SpinnerProps {
  /** Diameter in px (10–48). */
  size?: number;
}

/** Spinner — ported from Spinner.dc.html. Rotating loading ring. */
export function Spinner({ size = 22 }: SpinnerProps) {
  return <span class="gsv-spinner" style={{ width: `${size}px`, height: `${size}px` }} />;
}
