export type GsvGroupId = "overview" | "agents" | "operations" | "extensions" | "administration";

export type GsvSectionId =
  | "overview"
  | "agents"
  | "runtime"
  | "devices"
  | "packages"
  | "sources"
  | "integrations"
  | "access"
  | "settings";

export type Tone = "neutral" | "good" | "warning" | "danger" | "accent";

export type GsvGroup = {
  id: GsvGroupId;
  label: string;
  shortLabel: string;
  sections: GsvSectionId[];
};

export type GsvSection = {
  id: GsvSectionId;
  groupId: GsvGroupId;
  label: string;
  shortLabel: string;
  title: string;
  summary: string;
  statusLabel: string;
  tone: Tone;
  localItems: GsvLocalItem[];
  handoffs: GsvHandoff[];
};

export type GsvLocalItem = {
  label: string;
  description: string;
  meta: string;
  tone?: Tone;
};

export type GsvHandoff = {
  label: string;
  description: string;
  sectionId?: GsvSectionId;
  target?: string;
  route?: string;
};
