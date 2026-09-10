export type ConsoleListKind = "machines" | "library" | "tasks" | "messengers" | "integrations";

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
