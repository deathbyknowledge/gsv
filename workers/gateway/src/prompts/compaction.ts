import compactionPrompt from "./tasks/compaction.md";

// Used by process/do.ts when summarizing archived conversation segments during compaction.
export const COMPACTION_SUMMARY_SYSTEM_PROMPT = compactionPrompt.trimEnd();
