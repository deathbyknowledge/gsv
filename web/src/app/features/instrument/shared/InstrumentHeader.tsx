import type { ComponentChildren } from "preact";
import { Wordmark } from "./Wordmark";

export function InstrumentHeader({ status, children }: { status: ComponentChildren; children: ComponentChildren }) {
  return (
    <header class="instrument-top instrument-header">
      <Wordmark />
      <div class="instrument-heading">{status}</div>
      <nav class="keys" aria-label="Views">{children}</nav>
    </header>
  );
}
