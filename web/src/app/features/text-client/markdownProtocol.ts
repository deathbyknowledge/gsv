export type MarkdownBlock = {
  key: string;
  html: string;
};

export type MarkdownPreparationRequest = {
  type: "prepare";
  generation: number;
  source: string;
};

export type MarkdownPreparationResult = {
  type: "prepared";
  generation: number;
  blocks: MarkdownBlock[];
};

export type MarkdownPreparationFailure = {
  type: "failed";
  generation: number;
};

export type MarkdownWorkerResult = MarkdownPreparationResult | MarkdownPreparationFailure;
