import type { ComponentChildren } from "preact";
import { Wordmark } from "./Wordmark";

export function InstrumentHeader({ children }: { children: ComponentChildren }) {
  return (
    <header class="instrument-top instrument-header">
      <Wordmark />
      <nav class="keys" aria-label="Views">{children}</nav>
    </header>
  );
}
