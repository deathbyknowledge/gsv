export const INITIAL_HISTORY_GENERATION = 1;

export type HistorySegmentKind = "compaction";

export type ProcessHistorySegmentRecord = {
  id: string;
  generation: number;
  kind: HistorySegmentKind;
  fromMessageId: number;
  toMessageId: number;
  archivePath: string;
  summaryMessageId: number | null;
  createdAt: number;
};
