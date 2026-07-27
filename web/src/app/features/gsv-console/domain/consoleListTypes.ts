export type ConsoleListKind = "machines" | "library" | "tasks" | "messengers" | "integrations" | "applications";
export type PackageListKind = "applications";

export type ConsoleListSelection = {
  createNew?: boolean;
  detailId?: string;
  detailLabel?: string;
};

export type SelectedConsoleDetail = {
  createNew?: boolean;
  label?: string;
  kind: ConsoleListKind;
  id: string;
};

export const NEW_DETAIL_ID = "__new__";

export function isPackageListKind(kind: ConsoleListKind): kind is PackageListKind {
  return kind === "applications";
}
