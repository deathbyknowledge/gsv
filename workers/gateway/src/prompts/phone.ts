import type { PhoneBrief } from "@humansandmachines/gsv/protocol";
import voiceAgent from "./phone/voice-agent.md";

/** Voice agent instructions: the protected template, then the brief the owner approved. */
export function renderPhoneInstructions(brief: PhoneBrief): string {
  const list = (items: string[] | undefined) => items?.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
  const outsideLimits = (brief.ifOutsideLimits ?? "ask") === "ask"
    ? "Use the ask tool, tell the other person you are checking, and keep the line."
    : "Do not agree. Say you will call back, then end the call with outcome callback_needed.";
  const voicemail = (brief.voicemail ?? "hang_up") === "leave_message"
    ? "Leave a short message about the goal, then end the call with outcome voicemail."
    : "Hang up without leaving a message: end the call with outcome voicemail.";
  return [
    voiceAgent.trim().replaceAll("{{owner}}", () => brief.onBehalfOf),
    "",
    "Brief:",
    `- Calling: ${brief.business ?? brief.to}`,
    `- On behalf of: ${brief.onBehalfOf}`,
    `- Goal: ${brief.goal}`,
    ...(brief.language ? [`- Open the call in: ${brief.language}`] : []),
    "",
    "You may share:",
    list(brief.mayShare),
    "",
    "You must not:",
    list(brief.mustNot),
    "",
    `If the other person proposes something outside these limits: ${outsideLimits}`,
    `If you reach voicemail: ${voicemail}`,
  ].join("\n");
}
