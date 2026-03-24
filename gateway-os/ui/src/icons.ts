export type FileIconKind = "folder" | "image" | "archive" | "text" | "file";

export type DesktopIconId = "chat" | "shell" | "devices" | "processes" | "files" | "control";

export type ActionIconId = "new-file";

export function renderFileIcon(kind: FileIconKind): string {
  switch (kind) {
    case "folder":
      return `
        <span class="files-entry-icon is-folder" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="files-icon-fill" d="M3 7.5a2 2 0 0 1 2-2h4.3c.5 0 1 .2 1.4.57l1.3 1.23c.37.35.86.55 1.37.55H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <path class="files-icon-stroke" d="M3 7.5a2 2 0 0 1 2-2h4.3c.5 0 1 .2 1.4.57l1.3 1.23c.37.35.86.55 1.37.55H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <path class="files-icon-stroke" d="M3.5 10.5H20.5"/>
          </svg>
        </span>
      `;
    case "text":
      return `
        <span class="files-entry-icon is-text" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="files-icon-fill" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M14 3.5V8h4"/>
            <path class="files-icon-stroke" d="M9 11h6M9 14h6M9 17h4"/>
          </svg>
        </span>
      `;
    case "image":
      return `
        <span class="files-entry-icon is-image" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="files-icon-fill" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M14 3.5V8h4"/>
            <circle class="files-icon-stroke" cx="10" cy="11" r="1.2"/>
            <path class="files-icon-stroke" d="M9 18l2.4-2.5a1 1 0 0 1 1.42 0L15 17.8"/>
          </svg>
        </span>
      `;
    case "archive":
      return `
        <span class="files-entry-icon is-archive" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="files-icon-fill" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M14 3.5V8h4"/>
            <path class="files-icon-stroke" d="M11 10.2v7.1"/>
            <path class="files-icon-stroke" d="M9.4 10.2h3.2M9.8 13.2h2.4M9.8 16.2h2.4"/>
          </svg>
        </span>
      `;
    case "file":
    default:
      return `
        <span class="files-entry-icon is-file" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="files-icon-fill" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="files-icon-stroke" d="M14 3.5V8h4"/>
          </svg>
        </span>
      `;
  }
}

export function renderActionIcon(kind: ActionIconId): string {
  switch (kind) {
    case "new-file":
      return `
        <span class="inline-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="inline-icon-fill" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="inline-icon-stroke" d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/>
            <path class="inline-icon-stroke" d="M14 3.5V8h4"/>
            <path class="inline-icon-stroke" d="M12 11.5v5M9.5 14h5"/>
          </svg>
        </span>
      `;
  }
}

export function renderDesktopIcon(kind: DesktopIconId): string {
  switch (kind) {
    case "chat":
      return `
        <span class="desktop-glyph is-chat" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="desktop-icon-fill" d="M5.5 6.5A2.5 2.5 0 0 1 8 4h7a3.5 3.5 0 0 1 3.5 3.5V12A3.5 3.5 0 0 1 15 15.5H10l-3.7 3v-3A3 3 0 0 1 5.5 13z"/>
            <path class="desktop-icon-stroke" d="M5.5 6.5A2.5 2.5 0 0 1 8 4h7a3.5 3.5 0 0 1 3.5 3.5V12A3.5 3.5 0 0 1 15 15.5H10l-3.7 3v-3A3 3 0 0 1 5.5 13z"/>
            <path class="desktop-icon-stroke" d="m13.6 7.2.4 1.2 1.2.4-1.2.4-.4 1.2-.4-1.2-1.2-.4 1.2-.4z"/>
            <path class="desktop-icon-stroke" d="M9 10.7h3"/>
          </svg>
        </span>
      `;
    case "shell":
      return `
        <span class="desktop-glyph is-shell" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect class="desktop-icon-fill" x="4" y="5" width="16" height="14" rx="3"/>
            <rect class="desktop-icon-stroke" x="4" y="5" width="16" height="14" rx="3"/>
            <path class="desktop-icon-stroke" d="m8 10 2 2-2 2"/>
            <path class="desktop-icon-stroke" d="M12 15h4"/>
          </svg>
        </span>
      `;
    case "devices":
      return `
        <span class="desktop-glyph is-devices" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect class="desktop-icon-fill" x="5" y="5" width="14" height="9" rx="2.5"/>
            <rect class="desktop-icon-stroke" x="5" y="5" width="14" height="9" rx="2.5"/>
            <path class="desktop-icon-stroke" d="M9 18h6"/>
            <path class="desktop-icon-stroke" d="M12 14v4"/>
            <circle class="desktop-icon-stroke" cx="17.5" cy="17.5" r="2.5"/>
            <path class="desktop-icon-stroke" d="M17.5 16.3v2.4M16.3 17.5h2.4"/>
          </svg>
        </span>
      `;
    case "processes":
      return `
        <span class="desktop-glyph is-processes" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <circle class="desktop-icon-fill" cx="8" cy="8" r="2.6"/>
            <circle class="desktop-icon-fill" cx="16" cy="8" r="2.6"/>
            <circle class="desktop-icon-fill" cx="12" cy="16" r="2.6"/>
            <circle class="desktop-icon-stroke" cx="8" cy="8" r="2.6"/>
            <circle class="desktop-icon-stroke" cx="16" cy="8" r="2.6"/>
            <circle class="desktop-icon-stroke" cx="12" cy="16" r="2.6"/>
            <path class="desktop-icon-stroke" d="M10.2 9.4 11 10M13 10l.8-.6M10.4 13.7l.8-.9M13.6 12.8l-.8.9"/>
          </svg>
        </span>
      `;
    case "files":
      return `
        <span class="desktop-glyph is-files" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="desktop-icon-fill" d="M4 8a2 2 0 0 1 2-2h4.4c.5 0 1 .2 1.4.56l1.2 1.1c.37.34.85.54 1.36.54H18a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
            <path class="desktop-icon-stroke" d="M4 8a2 2 0 0 1 2-2h4.4c.5 0 1 .2 1.4.56l1.2 1.1c.37.34.85.54 1.36.54H18a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
            <path class="desktop-icon-stroke" d="M4.5 10.7h15"/>
          </svg>
        </span>
      `;
    case "control":
      return `
        <span class="desktop-glyph is-control" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="desktop-icon-stroke" d="M7 6v12M12 6v12M17 6v12"/>
            <circle class="desktop-icon-fill" cx="7" cy="9" r="2.4"/>
            <circle class="desktop-icon-fill" cx="12" cy="14" r="2.4"/>
            <circle class="desktop-icon-fill" cx="17" cy="10.5" r="2.4"/>
            <circle class="desktop-icon-stroke" cx="7" cy="9" r="2.4"/>
            <circle class="desktop-icon-stroke" cx="12" cy="14" r="2.4"/>
            <circle class="desktop-icon-stroke" cx="17" cy="10.5" r="2.4"/>
          </svg>
        </span>
      `;
  }
}
