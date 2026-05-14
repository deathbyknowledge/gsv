export type WikiIconName =
  | "book"
  | "build"
  | "database"
  | "edit"
  | "file"
  | "folder"
  | "inbox"
  | "search"
  | "spark";

export function WikiIcon({ name, className = "" }: { name: WikiIconName; className?: string }) {
  return (
    <svg class={`wiki-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      {iconPath(name)}
    </svg>
  );
}

function iconPath(name: WikiIconName) {
  if (name === "book") return <><path d="M5 4.5h9a3 3 0 0 1 3 3v12H8a3 3 0 0 0-3 3z"></path><path d="M5 4.5v15A3 3 0 0 1 8 16.5h9"></path></>;
  if (name === "build") return <><path d="M5 18.5h14"></path><path d="M7 18.5v-8l5-5 5 5v8"></path><path d="M10 18.5v-5h4v5"></path></>;
  if (name === "database") return <><ellipse cx="12" cy="5.5" rx="7" ry="3"></ellipse><path d="M5 5.5v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"></path><path d="M5 9c0 1.7 3.1 3 7 3s7-1.3 7-3"></path></>;
  if (name === "edit") return <><path d="M5 19h4l10-10-4-4L5 15z"></path><path d="m13.5 6.5 4 4"></path></>;
  if (name === "file") return <><path d="M7 3.5h7l3.5 3.5v13.5H7z"></path><path d="M14 3.5V7h3.5"></path><path d="M9 12h6"></path><path d="M9 15.5h4"></path></>;
  if (name === "folder") return <><path d="M3.5 7.5h6l2 2h9v8a2 2 0 0 1-2 2h-15z"></path><path d="M3.5 7.5v-1A1.5 1.5 0 0 1 5 5h4l2 2"></path></>;
  if (name === "inbox") return <><path d="M4.5 5.5h15l-1.5 13h-12z"></path><path d="M8 12h2.5l1.5 2 1.5-2H16"></path></>;
  if (name === "search") return <><circle cx="10.5" cy="10.5" r="6"></circle><path d="m15 15 5 5"></path></>;
  return <><path d="M12 3.5v4"></path><path d="M12 16.5v4"></path><path d="M4.5 12h4"></path><path d="M15.5 12h4"></path><path d="m6.7 6.7 2.8 2.8"></path><path d="m14.5 14.5 2.8 2.8"></path><path d="m17.3 6.7-2.8 2.8"></path><path d="m9.5 14.5-2.8 2.8"></path></>;
}
