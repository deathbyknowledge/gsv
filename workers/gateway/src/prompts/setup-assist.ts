import setupPrompt from "./tasks/setup-assist.md";

// Used by sys/setup-assist.ts as the system prompt for the first-boot setup helper.
export const SETUP_ASSIST_SYSTEM_PROMPT = setupPrompt.trimEnd();
