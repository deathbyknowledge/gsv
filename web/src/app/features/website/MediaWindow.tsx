import type { ComponentChildren } from "preact";

export interface MediaWindowProps {
  /** Filename or subject, shown in the title bar. */
  title?: string;
  children: ComponentChildren;
}

/** MediaWindow — a small system window, the way the desktop app surfaces an
 *  image the agent opened from the conversation: title bar with window
 *  controls, then the content. It reads as something the machine put on screen
 *  for you, not as page decoration. */
export function MediaWindow({ title, children }: MediaWindowProps) {
  return (
    <figure class="gsv-site-win">
      <div class="gsv-site-win-bar">
        <span class="gsv-site-win-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {title ? (
          <figcaption class="gsv-site-win-title gsv-sublabel">{title}</figcaption>
        ) : null}
      </div>
      <div class="gsv-site-win-body">{children}</div>
    </figure>
  );
}
