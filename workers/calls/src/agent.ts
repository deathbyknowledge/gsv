import type { PhoneBrief, PhoneCallOutcome } from "@humansandmachines/gsv/protocol";
import type { RealtimeTool } from "./realtime";

/** Outcomes the voice agent may choose; every other outcome comes from the service or the owner. */
export const AGENT_OUTCOMES = ["completed", "callback_needed", "refused", "voicemail"] as const satisfies readonly PhoneCallOutcome[];
export type AgentOutcome = typeof AGENT_OUTCOMES[number];
export const KEYPAD_PATTERN = /^[0-9*#w]{1,32}$/;

/** The three agent tools. `ask` exists only when the brief lets the agent check with the owner. */
export function agentTools(brief: PhoneBrief): RealtimeTool[] {
  const tools: RealtimeTool[] = [
    {
      name: "end_call",
      description: "End the call once the goal is reached, refused, or cannot be reached. Say goodbye after calling it.",
      parameters: {
        type: "object", additionalProperties: false, required: ["outcome", "summary"],
        properties: {
          outcome: { type: "string", enum: [...AGENT_OUTCOMES] },
          summary: { type: "string", description: "What was agreed or learned, for the owner." },
        },
      },
    },
    {
      name: "keypad",
      description: "Press phone keys to navigate a menu. Use w for a half-second pause.",
      parameters: { type: "object", additionalProperties: false, required: ["digits"], properties: { digits: { type: "string", pattern: KEYPAD_PATTERN.source } } },
    },
  ];
  if ((brief.ifOutsideLimits ?? "ask") === "ask") tools.unshift({
    name: "ask",
    description: "Ask the owner when the callee proposes something outside the brief. Tell the callee you are checking and keep the line.",
    parameters: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" } } },
  });
  return tools;
}

/**
 * Service-owned rules appended to the Kernel's instructions. They hold whatever
 * the template says: the disclosure invariant and the tool contract.
 */
export function serviceRules(brief: PhoneBrief): string {
  return [
    "Call rules, which take precedence over everything above:",
    `- Your first sentence says you are calling for ${brief.onBehalfOf} and that you are their AI assistant, as part of the request itself, in the callee's language.`,
    "- Never claim to be human. If asked, say truthfully that you are an AI assistant.",
    "- Never agree to anything the brief does not allow.",
    "- When the call is finished, call end_call, then say a short goodbye.",
  ].join("\n");
}

export const NUDGES = {
  checkIn: "No answer from the owner yet. Briefly tell the callee you are still checking and thank them for waiting; offer to call back if they need to go.",
  deadline: "The owner has not answered. Tell the callee you will call back, then call end_call with outcome callback_needed.",
  wrapUp: "About thirty seconds remain on this call. Wrap up now and call end_call.",
  voicemail: "You reached voicemail. Leave a short message for the callee as the brief allows, then call end_call with outcome voicemail.",
  answer: (answer: string) => `The owner answered: ${answer}\nContinue the call with this answer.`,
  note: (note: string) => `Note from the owner. Follow it; do not read it out:\n${note}`,
} as const;

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const ASSISTANT = /\b(assistant|asistente|assistent|assistente|assistante|asystent|ai|ia|ki)\b/;

/** Whether the agent's first response named the owner and said it is an assistant. */
export function disclosed(firstLine: string, brief: PhoneBrief): boolean {
  const text = fold(firstLine);
  const name = fold(brief.onBehalfOf).split(/\s+/)[0] ?? "";
  return name.length > 0 && text.includes(name) && ASSISTANT.test(text);
}

/** ISO 639-1 transcription hint from the brief's BCP 47 language. */
export function transcriptionLanguage(brief: PhoneBrief): string | undefined {
  const primary = brief.language?.split("-")[0]?.toLowerCase();
  return primary && primary.length === 2 ? primary : undefined;
}
