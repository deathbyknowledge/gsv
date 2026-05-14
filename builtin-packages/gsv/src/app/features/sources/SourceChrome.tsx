import type { ComponentChildren } from "preact";

export function SourcePill({ children, className = "" }: { children: ComponentChildren; className?: string }) {
  return <span class={`gsv-source-pill ${className}`}>{children}</span>;
}

export function SourceIcon({ name }: { name: "repo" | "folder" | "file" | "package" }) {
  if (name === "repo") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l3.5 3.5v13.5h-12a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"></path><path d="M14 3.5V7h3.5"></path><path d="M8 12h6"></path><path d="M8 15.5h8"></path></svg>;
  }
  if (name === "folder") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v7.5a2 2 0 0 1-2 2h-15z"></path><path d="M3.5 7.5v-1a1.5 1.5 0 0 1 1.5-1.5h4l2 2"></path></svg>;
  }
  if (name === "package") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"></path><path d="m4 7.5 8 4.5 8-4.5"></path><path d="M12 12v9"></path></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l3 3V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"></path><path d="M14 3.5V7h3"></path></svg>;
}
