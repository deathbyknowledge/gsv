export type IconName =
  | "activity"
  | "alert"
  | "arrow-left"
  | "arrow-right"
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "clock"
  | "code"
  | "copy"
  | "device"
  | "external"
  | "file"
  | "folder"
  | "git-commit"
  | "home"
  | "key"
  | "lock"
  | "package"
  | "plug"
  | "refresh"
  | "search"
  | "server"
  | "settings"
  | "shield"
  | "terminal"
  | "trash"
  | "unlock"
  | "user"
  | "x";

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg class={`gsv-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      {iconPath(name)}
    </svg>
  );
}

function iconPath(name: IconName) {
  if (name === "activity") return <><path d="M3.5 12h4l2-6 4 12 2-6h5"></path></>;
  if (name === "alert") return <><path d="M12 3.5 21 19H3z"></path><path d="M12 8.5v4.5"></path><path d="M12 16.5h.01"></path></>;
  if (name === "arrow-left") return <><path d="M19 12H5"></path><path d="m11 6-6 6 6 6"></path></>;
  if (name === "arrow-right") return <><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></>;
  if (name === "check") return <><path d="m4.5 12.5 5 5 10-11"></path></>;
  if (name === "chevron-left") return <><path d="m15 18-6-6 6-6"></path></>;
  if (name === "chevron-right") return <><path d="m9 18 6-6-6-6"></path></>;
  if (name === "clock") return <><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></>;
  if (name === "code") return <><path d="m9 8-4 4 4 4"></path><path d="m15 8 4 4-4 4"></path></>;
  if (name === "copy") return <><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"></path></>;
  if (name === "device") return <><rect x="5" y="3.5" width="14" height="17" rx="2"></rect><path d="M10 17.5h4"></path></>;
  if (name === "external") return <><path d="M9 5H5v14h14v-4"></path><path d="M13 5h6v6"></path><path d="m12 12 7-7"></path></>;
  if (name === "file") return <><path d="M7 3.5h7l3 3V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"></path><path d="M14 3.5V7h3"></path></>;
  if (name === "folder") return <><path d="M3.5 7.5h6l2 2h9v7.5a2 2 0 0 1-2 2h-15z"></path><path d="M3.5 7.5v-1A1.5 1.5 0 0 1 5 5h4l2 2"></path></>;
  if (name === "git-commit") return <><circle cx="12" cy="12" r="3"></circle><path d="M3.5 12h5.5"></path><path d="M15 12h5.5"></path></>;
  if (name === "home") return <><path d="M4 11.5 12 4l8 7.5"></path><path d="M6.5 10.5V20h11v-9.5"></path></>;
  if (name === "key") return <><circle cx="8" cy="14" r="3.5"></circle><path d="m10.5 11.5 8-8"></path><path d="m15 7 2 2"></path></>;
  if (name === "lock") return <><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7.5a4 4 0 0 1 8 0V10"></path></>;
  if (name === "package") return <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"></path><path d="m4 7.5 8 4.5 8-4.5"></path><path d="M12 12v9"></path></>;
  if (name === "plug") return <><path d="M8 3v5"></path><path d="M16 3v5"></path><path d="M6 8h12v3a6 6 0 0 1-12 0z"></path><path d="M12 17v4"></path></>;
  if (name === "refresh") return <><path d="M20 6v5h-5"></path><path d="M4 18v-5h5"></path><path d="M18 10a6.5 6.5 0 0 0-11-3l-3 3"></path><path d="M6 14a6.5 6.5 0 0 0 11 3l3-3"></path></>;
  if (name === "search") return <><circle cx="10.5" cy="10.5" r="6"></circle><path d="m15 15 5 5"></path></>;
  if (name === "server") return <><rect x="4" y="4" width="16" height="6" rx="1.5"></rect><rect x="4" y="14" width="16" height="6" rx="1.5"></rect><path d="M8 7h.01"></path><path d="M8 17h.01"></path></>;
  if (name === "settings") return <><circle cx="12" cy="12" r="3"></circle><path d="M12 3.5v2"></path><path d="M12 18.5v2"></path><path d="m5.95 5.95 1.4 1.4"></path><path d="m16.65 16.65 1.4 1.4"></path><path d="M3.5 12h2"></path><path d="M18.5 12h2"></path><path d="m5.95 18.05 1.4-1.4"></path><path d="m16.65 7.35 1.4-1.4"></path></>;
  if (name === "shield") return <><path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.1-7 9-4.2-1.9-7-4.8-7-9V6z"></path><path d="m9 12 2 2 4-4"></path></>;
  if (name === "terminal") return <><path d="m5 7 5 5-5 5"></path><path d="M12 17h7"></path></>;
  if (name === "trash") return <><path d="M4.5 7h15"></path><path d="M9 7V4.5h6V7"></path><path d="M7 7l1 13h8l1-13"></path></>;
  if (name === "unlock") return <><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7.5A4 4 0 0 1 15.5 6"></path></>;
  if (name === "user") return <><circle cx="12" cy="8" r="4"></circle><path d="M4.5 20a7.5 7.5 0 0 1 15 0"></path></>;
  return <><path d="M6 6l12 12"></path><path d="M18 6 6 18"></path></>;
}
