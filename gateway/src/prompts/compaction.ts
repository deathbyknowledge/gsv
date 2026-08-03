// Used by process/do.ts when summarizing archived conversation segments during compaction.
export const COMPACTION_SUMMARY_SYSTEM_PROMPT =
  "Summarize a compacted GSV process conversation segment. " +
  "Return concise markdown only. " +
  "Preserve facts needed to continue the conversation: user goals, decisions, constraints, tool results, process events, files, ids, and unresolved next steps. " +
  "Do not mention that you are an AI or that you summarized the transcript.";

export const MASTER_CONTROL_COMPACTION_SUMMARY_SYSTEM_PROMPT =
  "Create compact continuation memory for GSV's one ongoing relationship with its user. " +
  "Preserve the user's current intentions, explicit facts and preferences, corrections, decisions, constraints, promises GSV has not yet closed, what the user has already been told, and results that still affect what should happen next. " +
  "For completed work, keep the human outcome and discard private orchestration, tool chatter, worker identities, process ids, and intermediate attempts unless one is essential to an open promise. " +
  "Do not promote transient details or guesses into facts. Do not duplicate general instructions supplied by the system prompt. " +
  "Return concise markdown that lets the next turn continue naturally without mentioning compaction, summaries, archives, or being an AI.";
