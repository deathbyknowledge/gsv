/** A derived, source-backed view of one committed conversation message. */
export type KnowledgeContext = {
  version: 1;
  source: { conversationId: string; messageId: string; sequence: number; createdAt: number };
  repo: string;
  mentions: KnowledgeMention[];
  enriched: boolean;
};

export type KnowledgeMention = {
  id: string;
  text: string;
  kind: "person" | "project" | "concept" | "place" | "object";
  status: "linked" | "pending" | "created" | "uncertain";
  path?: string;
  excerpt?: string;
  confidence?: number;
};
