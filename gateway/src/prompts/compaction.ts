// Used by process/do.ts when summarizing archived conversation segments during compaction.
export const COMPACTION_SUMMARY_SYSTEM_PROMPT =
  "Summarize a compacted GSV process conversation segment. " +
  "Return concise markdown only. " +
  "Preserve facts needed to continue the conversation: user goals, decisions, constraints, tool results, process events, files, ids, and unresolved next steps. " +
  "Do not mention that you are an AI or that you summarized the transcript.";
