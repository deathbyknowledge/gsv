import type { ComponentChildren } from "preact";

export interface MediaWindowProps {
  /** Filename or subject, shown in the title bar. */
  title?: string;
  /** Narrows the window for upright content, so a portrait photo isn't cropped
   *  to a letterbox to fit a landscape column. */
  portrait?: boolean;
  children: ComponentChildren;
}

/** MediaWindow — a small system window, the way the desktop app surfaces an
 *  image the agent opened from the conversation: title bar with window
 *  controls, then the content. It reads as something the machine put on screen
 *  for you, not as page decoration. */
export function MediaWindow({ title, portrait = false, children }: MediaWindowProps) {
  return (
    <figure class={`gsv-site-win${portrait ? " is-portrait" : ""}`}>
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
